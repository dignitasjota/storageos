import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  renderAdminEmail,
  type AdminAnonymizeResultDto,
  type AdminConsistencyIssueDto,
  type AdminSubscriptionPreviewDto,
  type AdminTenantConsistencyDto,
  type AdminTenantDto,
  type AnonymizeTenantInput,
  type CancelTenantInput,
  type ConsistencyCode,
  type SubscriptionPreviewQuery,
  type TenantSubscriptionPaymentDto,
  type UpdateTenantAddonInput,
} from '@storageos/shared';

import { formatDateLong, todayInTimezone, zonedNextDayStart } from '../../common/format';
import { AuditService } from '../auth/audit.service';
import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { addMonthsUtc } from '../billing-saas/platform-due';
import { PlatformSepaMandateService } from '../billing-saas/platform-sepa/platform-sepa-mandate.service';
import { SaasAddonsService } from '../billing-saas/saas-addons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import { AdminBillingOpsService, type SubscriptionStatePatch } from './admin-billing-ops.service';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminTodayService } from './admin-today.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Env } from '../../config/env.schema';

const DAY = 86_400_000;

interface Meta {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const MODE_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  sepa: 'domiciliación SEPA',
  redsys: 'tarjeta guardada (Redsys)',
  manual: 'pago manual',
};

/** Medianoche del día siguiente en España: lo programado «para hoy» se aplica hoy. */
function endOfTodayMadrid(now: Date): Date {
  return zonedNextDayStart(todayInTimezone('Europe/Madrid', now).toISOString().slice(0, 10));
}

/**
 * Ciclo de vida de un tenant desde el panel del super admin: dar de baja (hoy o
 * al acabar lo pagado, con deshacer mientras no se aplique), anonimización con
 * periodo de gracia, vista previa de cada acción sobre la suscripción, avisos
 * de incoherencias con su arreglo, anular pagos a mano y editar o cobrar
 * extras. Las bajas y anonimizaciones programadas las aplica un cron diario.
 */
@Injectable()
export class AdminTenantLifecycleService {
  private readonly logger = new Logger(AdminTenantLifecycleService.name);
  private readonly webBaseUrl: string;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly billingOps: AdminBillingOpsService,
    private readonly saasBilling: BillingSaasService,
    private readonly addons: SaasAddonsService,
    private readonly sepaMandates: PlatformSepaMandateService,
    private readonly today: AdminTodayService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly email: EmailService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  private async tenantOrThrow(tenantId: string) {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!t || t.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    return t;
  }

  private async trace(
    tenantId: string,
    action: string,
    meta: { superAdminId: string | null; ipAddress?: string | null; userAgent?: string | null },
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId,
      userId: null,
      action,
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: meta.superAdminId, ...changes },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // ============================================================ dar de baja

  /**
   * Da de baja: deja de cobrarse por cualquier vía (Stripe cancelada, fuera de
   * la remesa SEPA y del cobro de Redsys, extras sin próximo cobro) y pasa a
   * cancelado hoy o, con `period_end`, el día que acaba lo pagado (hasta
   * entonces sigue operando y se puede deshacer).
   */
  async cancel(tenantId: string, input: CancelTenantInput, meta: Meta): Promise<AdminTenantDto> {
    const t = await this.tenantOrThrow(tenantId);
    if (t.status === 'cancelled') {
      throw new BadRequestException({
        code: 'already_cancelled',
        message: 'El tenant ya está dado de baja.',
      });
    }
    if (t.cancelScheduledAt) {
      throw new ConflictException({
        code: 'cancel_already_scheduled',
        message: 'Ya tiene la baja programada: deshazla antes si quieres cambiarla.',
      });
    }
    const now = new Date();
    const periodEnd = t.subscription?.currentPeriodEnd ?? null;
    const scheduled =
      input.effective === 'period_end' &&
      !!periodEnd &&
      periodEnd > now &&
      t.status !== 'trial' &&
      !t.billingExempt;
    // Primero, que deje de cobrarse (si Stripe no lo confirma, no se sigue).
    const stopped = await this.saasBilling.stopAllCharging(tenantId);
    if (scheduled) {
      await this.admin.tenant.update({
        where: { id: tenantId },
        data: {
          cancelScheduledAt: periodEnd,
          cancelScheduledReason: input.churnReason,
          cancelScheduledNote: input.reason,
          cancelScheduledBy: meta.superAdminId,
        },
      });
    } else {
      await this.admin.tenant.update({
        where: { id: tenantId },
        data: {
          status: 'cancelled',
          canceledAt: now,
          churnReason: input.churnReason,
          cancelScheduledAt: null,
          cancelScheduledReason: null,
          cancelScheduledNote: null,
          cancelScheduledBy: null,
        },
      });
    }
    await this.trace(
      tenantId,
      scheduled ? 'admin.tenant.cancel_scheduled' : 'admin.tenant.cancelled',
      meta,
      {
        reason: input.reason,
        churnReason: input.churnReason,
        previousStatus: t.status,
        previousBillingMode: stopped.previousMode,
        stripeCancelled: stopped.stripeCancelled,
        ...(scheduled ? { effectiveAt: periodEnd!.toISOString() } : {}),
      },
    );
    return this.tenants.detail(tenantId);
  }

  /**
   * Deshace una baja programada (aún sin aplicar). La cuota vuelve a cobrarse
   * como antes si se puede (mandato SEPA o tarjeta guardada siguen ahí); con
   * Stripe queda en pago manual (su suscripción ya se canceló).
   */
  async undoCancel(tenantId: string, reason: string, meta: Meta): Promise<AdminTenantDto> {
    const t = await this.tenantOrThrow(tenantId);
    if (!t.cancelScheduledAt || t.status === 'cancelled') {
      throw new BadRequestException({
        code: 'no_cancel_scheduled',
        message: 'No tiene ninguna baja programada pendiente de aplicar.',
      });
    }
    const last = await this.admin.superAdminAuditLog.findFirst({
      where: { targetTenantId: tenantId, action: 'admin.tenant.cancel_scheduled' },
      orderBy: { occurredAt: 'desc' },
      select: { changes: true },
    });
    const previous = (last?.changes as { previousBillingMode?: string } | null)
      ?.previousBillingMode;
    let restoredMode: string = 'manual';
    if (previous === 'sepa' && (await this.sepaMandates.hasActiveMandate(tenantId))) {
      restoredMode = 'sepa';
    } else if (previous === 'redsys') {
      const card = await this.admin.platformRedsysCard.findUnique({ where: { tenantId } });
      if (card) restoredMode = 'redsys';
    }
    const periodEnd = t.subscription?.currentPeriodEnd ?? new Date();
    await this.admin.$transaction([
      this.admin.tenant.update({
        where: { id: tenantId },
        data: {
          cancelScheduledAt: null,
          cancelScheduledReason: null,
          cancelScheduledNote: null,
          cancelScheduledBy: null,
        },
      }),
      ...(t.subscription && restoredMode !== 'manual'
        ? [
            this.admin.tenantSubscription.update({
              where: { tenantId },
              data: { billingMode: restoredMode },
            }),
          ]
        : []),
      // Los extras a mano vuelven a cobrarse al acabar el periodo pagado.
      this.admin.tenantSubscriptionAddon.updateMany({
        where: { tenantId, billingMode: 'manual', suspendedAt: null, nextChargeAt: null },
        data: { nextChargeAt: periodEnd > new Date() ? periodEnd : new Date() },
      }),
    ]);
    await this.trace(tenantId, 'admin.tenant.cancel_undone', meta, {
      reason,
      restoredBillingMode: restoredMode,
      previousBillingMode: previous ?? null,
    });
    return this.tenants.detail(tenantId);
  }

  /** Aplica las bajas programadas que tocan hoy (cron diario). */
  async applyDueCancellations(now = new Date()): Promise<number> {
    const due = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        status: { not: 'cancelled' },
        cancelScheduledAt: { lt: endOfTodayMadrid(now) },
      },
      select: {
        id: true,
        status: true,
        cancelScheduledAt: true,
        cancelScheduledReason: true,
        cancelScheduledNote: true,
        cancelScheduledBy: true,
      },
    });
    let applied = 0;
    for (const t of due) {
      const res = await this.admin.tenant.updateMany({
        where: { id: t.id, status: { not: 'cancelled' }, cancelScheduledAt: t.cancelScheduledAt },
        data: {
          status: 'cancelled',
          canceledAt: t.cancelScheduledAt,
          churnReason: t.cancelScheduledReason,
          cancelScheduledAt: null,
          cancelScheduledReason: null,
          cancelScheduledNote: null,
          cancelScheduledBy: null,
        },
      });
      if (res.count === 0) continue;
      applied += 1;
      await this.trace(
        t.id,
        'admin.tenant.cancelled',
        { superAdminId: t.cancelScheduledBy },
        {
          reason: t.cancelScheduledNote,
          churnReason: t.cancelScheduledReason,
          previousStatus: t.status,
          scheduled: true,
        },
      );
    }
    return applied;
  }

  // ============================================================ anonimizar

  /**
   * Anonimizar: sin días de gracia, ahora (lo de siempre). Con días, se da de
   * baja si no lo estaba (deja de cobrarse), se programa, se avisa a los
   * propietarios por correo y se puede cancelar hasta ese día.
   */
  async requestAnonymize(
    tenantId: string,
    input: AnonymizeTenantInput,
    meta: Meta,
  ): Promise<AdminAnonymizeResultDto> {
    const graceDays = input.graceDays ?? 0;
    if (graceDays === 0) {
      const res = await this.tenants.anonymize(tenantId, { ...meta, reason: input.reason });
      return { ...res, scheduledFor: null };
    }
    let t = await this.tenantOrThrow(tenantId);
    if (t.anonymizeScheduledAt) {
      throw new ConflictException({
        code: 'anonymize_already_scheduled',
        message: 'Ya tiene la anonimización programada.',
      });
    }
    // Paso 1: que deje de cobrarse (se da de baja hoy si no lo estaba).
    if (t.status !== 'cancelled' && !t.cancelScheduledAt) {
      await this.cancel(
        tenantId,
        { churnReason: input.churnReason ?? 'other', reason: input.reason, effective: 'now' },
        meta,
      );
      t = await this.tenantOrThrow(tenantId);
    }
    let at = new Date(Date.now() + graceDays * DAY);
    // Una baja programada más tarde se respeta: primero la baja.
    if (t.cancelScheduledAt && t.cancelScheduledAt > at) at = t.cancelScheduledAt;
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        anonymizeScheduledAt: at,
        anonymizeScheduledReason: input.reason,
        anonymizeScheduledBy: meta.superAdminId,
      },
    });
    await this.noticeOwners(tenantId, t.name, at);
    await this.trace(tenantId, 'admin.tenant.anonymize_scheduled', meta, {
      reason: input.reason,
      scheduledFor: at.toISOString(),
      graceDays,
    });
    return { tenantId, scheduledFor: at.toISOString(), anonymizedCustomers: 0, anonymizedUsers: 0 };
  }

  private async noticeOwners(tenantId: string, tenantName: string, at: Date): Promise<void> {
    try {
      const owners = await this.admin.user.findMany({
        where: { tenantId, role: 'owner', isActive: true },
        select: { email: true },
      });
      const { html, text } = renderAdminEmail(
        [
          `La cuenta de ${tenantName} en TrasterOS está dada de baja y sus datos se borrarán el ${formatDateLong(at)}.`,
          'Hasta ese día puedes entrar en tu panel y descargar lo que necesites (Configuración → Exportar tus datos). Las facturas emitidas se conservan, como exige la ley.',
          `Si es un error o quieres seguir, escríbenos desde Soporte en tu panel: ${this.webBaseUrl}/support`,
        ].join('\n\n'),
      );
      for (const o of owners) {
        await this.email.sendRendered({
          to: o.email,
          kind: 'admin_message',
          subject: `Los datos de ${tenantName} se borrarán el ${formatDateLong(at)}`,
          html,
          text,
        });
      }
    } catch (err) {
      this.logger.warn(`Aviso de anonimización (${tenantId}): ${String(err)}`);
    }
  }

  async cancelAnonymize(tenantId: string, reason: string, meta: Meta): Promise<AdminTenantDto> {
    const t = await this.tenantOrThrow(tenantId);
    if (!t.anonymizeScheduledAt) {
      throw new BadRequestException({
        code: 'no_anonymize_scheduled',
        message: 'No tiene ninguna anonimización programada.',
      });
    }
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        anonymizeScheduledAt: null,
        anonymizeScheduledReason: null,
        anonymizeScheduledBy: null,
      },
    });
    await this.trace(tenantId, 'admin.tenant.anonymize_cancelled', meta, {
      reason,
      wasScheduledFor: t.anonymizeScheduledAt.toISOString(),
    });
    return this.tenants.detail(tenantId);
  }

  /** Ejecuta las anonimizaciones programadas que tocan (cron diario). */
  async runDueAnonymizations(now = new Date()): Promise<number> {
    const due = await this.admin.tenant.findMany({
      where: { deletedAt: null, anonymizeScheduledAt: { lt: endOfTodayMadrid(now) } },
      select: { id: true, anonymizeScheduledReason: true, anonymizeScheduledBy: true },
    });
    let done = 0;
    for (const t of due) {
      try {
        await this.tenants.anonymize(t.id, {
          // Quien la programó (el registro la atribuye a esa persona).
          superAdminId: t.anonymizeScheduledBy as string,
          reason: t.anonymizeScheduledReason ?? 'Anonimización programada',
        });
        done += 1;
      } catch (err) {
        // Se reintenta mañana (p. ej. Stripe sin confirmar la cancelación).
        this.logger.error(`Anonimización programada de ${t.id} fallida: ${String(err)}`);
      }
    }
    return done;
  }

  // ======================================================== vista previa

  async preview(
    tenantId: string,
    q: SubscriptionPreviewQuery,
  ): Promise<AdminSubscriptionPreviewDto> {
    const t = await this.tenantOrThrow(tenantId);
    const sub = t.subscription;
    const now = new Date();
    const before = await this.billingOps.subscriptionState(tenantId, {}, now);
    const pricing = await this.admin.platformBillingSettings.findFirst({
      select: { pricesIncludeVat: true },
    });
    const patch: SubscriptionStatePatch = {};
    const effects: string[] = [];
    const warnings: string[] = [];
    const onStripe = !!sub?.stripeSubscriptionId && sub.billingMode === 'stripe';

    switch (q.action) {
      case 'change_plan': {
        const plan = q.planSlug
          ? await this.admin.subscriptionPlan.findUnique({ where: { slug: q.planSlug } })
          : null;
        if (!plan) {
          throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
        }
        patch.plan = {
          name: plan.name,
          priceMonthly: Number(plan.priceMonthly),
          priceYearly: Number(plan.priceYearly),
        };
        if (t.status === 'trial' || sub?.status === 'trial') {
          patch.tenantStatus = 'active';
          patch.trialEndsAt = null;
          patch.subStatus = 'active';
          effects.push('Acaba la prueba: pasa a activo en el plan nuevo.');
        }
        if (onStripe) {
          effects.push(
            'Se cambia también el precio en Stripe, con prorrateo en la próxima factura.',
          );
        }
        if (Number(plan.priceMonthly) <= 0 && sub?.status === 'past_due') {
          patch.subStatus = 'active';
          effects.push('A un plan gratis la cuota deja de deberse.');
        }
        effects.push('Los extras que el plan nuevo ya incluye o no admite se quitan (con aviso).');
        break;
      }
      case 'billing_mode': {
        const mode = q.mode ?? 'manual';
        patch.billingMode = mode;
        patch.stripeSubscriptionId = null;
        if (onStripe) {
          effects.push('Se cancela la suscripción en Stripe: deja de cobrar por allí.');
          effects.push('Los extras que cobraba Stripe pasan a cobrarse con el nuevo modo.');
          if (sub?.status === 'past_due') {
            warnings.push('Sigue en impago: la deuda se cuenta desde el cobro que falló.');
          }
        }
        if (mode === 'sepa') {
          effects.push(
            'La cuota entra en la remesa SEPA cuando venza (con preaviso por correo al tenant).',
          );
          if (!(await this.sepaMandates.hasActiveMandate(tenantId))) {
            warnings.push('No tiene un mandato SEPA activo: no se podrá pasar a SEPA.');
          }
        } else {
          effects.push('A partir de ahora se registran los pagos a mano (transferencia…).');
        }
        break;
      }
      case 'exempt':
        patch.billingExempt = true;
        patch.tenantStatus = 'active';
        patch.trialEndsAt = null;
        if (sub && ['trial', 'past_due', 'expired', 'cancelled'].includes(sub.status)) {
          patch.subStatus = 'active';
        }
        effects.push('Deja de cobrarse y sale de todas las métricas de negocio.');
        if (sub?.stripeSubscriptionId || ['sepa', 'redsys'].includes(sub?.billingMode ?? '')) {
          warnings.push(
            `Sigue con ${MODE_LABEL[sub?.billingMode ?? ''] ?? sub?.billingMode}: pásalo antes a pago manual o se le seguirá cobrando.`,
          );
        }
        break;
      case 'unexempt':
        patch.billingExempt = false;
        if (!onStripe) {
          patch.periodStart = now;
          patch.periodEnd = addMonthsUtc(now, 1);
          effects.push('El periodo empieza hoy: la primera cuota vence dentro de un mes.');
        }
        effects.push(
          'Los extras a mano se cobran dentro de un mes. Vuelve a contar en las métricas.',
        );
        break;
      case 'end_trial': {
        if (t.status !== 'trial') {
          throw new BadRequestException({
            code: 'tenant_not_in_trial',
            message: 'El tenant no está en periodo de prueba.',
          });
        }
        const willCharge = sub?.billingMode === 'sepa' || sub?.billingMode === 'redsys';
        patch.tenantStatus = 'active';
        patch.trialEndsAt = null;
        if (sub && !['active', 'past_due'].includes(sub.status)) {
          patch.subStatus = willCharge ? 'active' : 'expired';
        }
        effects.push(
          willCharge
            ? `Se le cobrará por ${MODE_LABEL[sub?.billingMode ?? '']} al vencer.`
            : 'Sin pagar, su panel queda en solo lectura hasta que elija cómo pagar.',
        );
        break;
      }
      case 'extend_trial': {
        const days = q.days ?? 14;
        const base = t.trialEndsAt && t.trialEndsAt > now ? t.trialEndsAt : new Date(now.getTime());
        const end = new Date(base.getTime() + days * DAY);
        patch.trialEndsAt = end;
        if (t.status !== 'cancelled') patch.tenantStatus = 'trial';
        if (sub && (sub.status === 'trial' || sub.status === 'expired')) {
          patch.subStatus = 'trial';
          patch.periodEnd = end;
        }
        effects.push(`La prueba acaba el ${formatDateLong(end)}.`);
        effects.push('Recibirá los avisos de fin de prueba de nuevo según la fecha nueva.');
        break;
      }
      case 'forgive': {
        if (sub?.status !== 'past_due') {
          warnings.push('No debe nada: no hay periodo que perdonar.');
          break;
        }
        if (onStripe) {
          throw new BadRequestException({
            code: 'forgive_not_on_stripe',
            message:
              'Paga por Stripe: perdona la factura desde Stripe o pásalo antes a pago manual.',
          });
        }
        const next = addMonthsUtc(sub.currentPeriodEnd, 1);
        patch.subStatus = 'active';
        patch.periodEnd = next > now ? next : new Date(now.getTime() + 30 * DAY);
        if (t.status === 'suspended') patch.tenantStatus = 'active';
        effects.push('Se le regala el periodo impagado: no se le cobra.');
        break;
      }
      case 'cancel': {
        const scheduled =
          q.effective === 'period_end' &&
          !!sub &&
          sub.currentPeriodEnd > now &&
          t.status !== 'trial' &&
          !t.billingExempt;
        patch.noCharges = true;
        patch.billingMode = 'manual';
        patch.stripeSubscriptionId = null;
        if (!scheduled) patch.tenantStatus = 'cancelled';
        effects.push(
          scheduled
            ? `Sigue operando hasta el ${formatDateLong(sub!.currentPeriodEnd)}; ese día pasa a dado de baja.`
            : 'Pasa a dado de baja hoy.',
        );
        if (onStripe) effects.push('Se cancela su suscripción en Stripe (no habrá más cobros).');
        if (sub?.billingMode === 'sepa') {
          effects.push('Sale de las próximas remesas SEPA (el mandato se conserva).');
          const pending = await this.admin.platformSepaRemittanceItem.count({
            where: { tenantId, itemStatus: 'pending' },
          });
          if (pending > 0) {
            warnings.push(
              'Tiene un adeudo en una remesa ya enviada al banco: si se cobra, devuélvelo a mano.',
            );
          }
        }
        if (sub?.billingMode === 'redsys') {
          effects.push('Se desactiva el cobro automático con su tarjeta guardada.');
        }
        effects.push('Sus extras dejan de tener próximo cobro. Cuenta como baja en Métricas.');
        if (before.debt) {
          warnings.push(
            `Debe ${before.debt.amount.toFixed(2).replace('.', ',')} €: no se le reclamará automáticamente.`,
          );
        }
        if (onStripe && scheduled) {
          warnings.push(
            'Si deshaces la baja, queda en pago manual: su suscripción de Stripe no se recupera.',
          );
        }
        break;
      }
    }
    const after = await this.billingOps.subscriptionState(tenantId, patch, now);
    return {
      action: q.action,
      before,
      after,
      effects,
      warnings,
      pricesIncludeVat: pricing?.pricesIncludeVat ?? true,
    };
  }

  // ======================================================== incoherencias

  async consistency(tenantId: string): Promise<AdminTenantConsistencyDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      include: { subscription: true },
    });
    if (!t) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const stripeAddons = await this.admin.tenantSubscriptionAddon.count({
      where: { tenantId, billingMode: 'stripe', suspendedAt: null },
    });
    return { issues: this.issuesOf(t, stripeAddons) };
  }

  private issuesOf(
    t: {
      status: string;
      deletedAt: Date | null;
      billingExempt: boolean;
      trialEndsAt: Date | null;
      subscription: {
        status: string;
        billingMode: string;
        stripeSubscriptionId: string | null;
        currentPeriodEnd: Date;
      } | null;
    },
    stripeAddons: number,
  ): AdminConsistencyIssueDto[] {
    const now = Date.now();
    const sub = t.subscription;
    const auto =
      !!sub && (!!sub.stripeSubscriptionId || ['sepa', 'redsys'].includes(sub.billingMode));
    const autoLabel = sub ? (MODE_LABEL[sub.billingMode] ?? sub.billingMode) : '';
    const issues: AdminConsistencyIssueDto[] = [];
    const add = (code: ConsistencyCode, title: string, detail: string, fixLabel: string | null) =>
      issues.push({ code, title, detail, fixLabel });

    if (t.deletedAt) {
      if (sub && (auto || ['active', 'past_due', 'trial'].includes(sub.status))) {
        add(
          'anonymized_with_live_subscription',
          'Anonimizado con la suscripción viva',
          'Está anonimizado pero su suscripción sigue activa o con cobro automático.',
          'Cerrar la suscripción',
        );
      }
      return issues;
    }
    if (t.status === 'trial' && t.trialEndsAt && t.trialEndsAt.getTime() < now) {
      add(
        'trial_expired',
        'La prueba venció y sigue en prueba',
        `La prueba acabó el ${formatDateLong(t.trialEndsAt)} y no se ha cerrado.`,
        'Cerrar la prueba',
      );
    }
    if (t.status === 'trial' && sub && ['active', 'past_due'].includes(sub.status)) {
      add(
        'paid_still_trial',
        'Paga pero sigue en prueba',
        'La suscripción está activa y el tenant aparece en prueba (sale en «Pruebas por expirar»).',
        'Pasarlo a activo',
      );
    }
    if (t.status === 'active' && sub?.status === 'trial') {
      add(
        'trial_subscription_on_active',
        'Activo con la suscripción en prueba',
        'El tenant está activo pero su suscripción sigue en prueba: no se le cobra.',
        'Cerrar la prueba de la suscripción',
      );
    }
    if (t.status === 'cancelled' && sub && (auto || ['active', 'past_due'].includes(sub.status))) {
      add(
        'cancelled_still_charging',
        'De baja con la suscripción viva',
        auto
          ? `Está de baja y sigue con ${autoLabel}: se le puede seguir cobrando.`
          : 'Está de baja y su suscripción sigue activa.',
        'Cortar los cobros',
      );
    }
    if (t.billingExempt && auto) {
      add(
        'exempt_with_autocharge',
        'Exenta con cobro automático',
        `Es una cuenta exenta y sigue con ${autoLabel}: se le seguiría cobrando.`,
        'Pasar a pago manual',
      );
    }
    if (
      t.status === 'trial' &&
      t.trialEndsAt &&
      sub &&
      sub.status === 'trial' &&
      Math.abs(t.trialEndsAt.getTime() - sub.currentPeriodEnd.getTime()) > DAY
    ) {
      add(
        'trial_period_mismatch',
        'El fin de la prueba no cuadra con el periodo',
        `La prueba acaba el ${formatDateLong(t.trialEndsAt)} y el periodo el ${formatDateLong(sub.currentPeriodEnd)}.`,
        'Igualar al fin de la prueba',
      );
    }
    if (stripeAddons > 0 && !sub?.stripeSubscriptionId) {
      add(
        'stripe_addons_without_subscription',
        'Extras «en Stripe» sin suscripción de Stripe',
        `${stripeAddons} ${stripeAddons === 1 ? 'extra figura' : 'extras figuran'} cobrándose por Stripe, pero no hay suscripción: no se cobran.`,
        'Pasarlos a cobro manual',
      );
    }
    if (t.status === 'suspended' && auto && !t.billingExempt) {
      add(
        'suspended_with_autocharge',
        'Suspendido con cobro automático',
        `Está suspendido y sigue con ${autoLabel}: se le sigue cobrando.`,
        'Pasar a pago manual',
      );
    }
    return issues;
  }

  async fixConsistency(
    tenantId: string,
    code: ConsistencyCode,
    meta: Meta,
  ): Promise<AdminTenantConsistencyDto> {
    const current = await this.consistency(tenantId);
    if (!current.issues.some((i) => i.code === code)) {
      throw new ConflictException({
        code: 'issue_not_found',
        message: 'Ese aviso ya no está: actualiza la página.',
      });
    }
    const meta2 = { ...meta, reason: 'Corregir incoherencia' };
    switch (code) {
      case 'trial_expired':
        await this.tenants.endTrial(tenantId, meta2);
        break;
      case 'paid_still_trial':
        await this.admin.tenant.update({
          where: { id: tenantId },
          data: { status: 'active', trialEndsAt: null },
        });
        break;
      case 'trial_subscription_on_active': {
        const sub = await this.admin.tenantSubscription.findUnique({
          where: { tenantId },
          select: { billingMode: true },
        });
        const willCharge = sub?.billingMode === 'sepa' || sub?.billingMode === 'redsys';
        await this.admin.tenantSubscription.update({
          where: { tenantId },
          data: { status: willCharge ? 'active' : 'expired' },
        });
        break;
      }
      case 'cancelled_still_charging':
      case 'exempt_with_autocharge':
      case 'suspended_with_autocharge':
        await this.saasBilling.stopAllCharging(tenantId, { stopManualAddons: false });
        break;
      case 'anonymized_with_live_subscription':
        await this.saasBilling.stopAllCharging(tenantId);
        await this.admin.tenantSubscription.update({
          where: { tenantId },
          data: { status: 'cancelled' },
        });
        break;
      case 'trial_period_mismatch': {
        const t = await this.admin.tenant.findUnique({
          where: { id: tenantId },
          select: { trialEndsAt: true },
        });
        if (t?.trialEndsAt) {
          await this.admin.tenantSubscription.update({
            where: { tenantId },
            data: { currentPeriodEnd: t.trialEndsAt },
          });
        }
        break;
      }
      case 'stripe_addons_without_subscription': {
        const sub = await this.admin.tenantSubscription.findUnique({
          where: { tenantId },
          select: { currentPeriodEnd: true },
        });
        const next = sub && sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
        await this.admin.tenantSubscriptionAddon.updateMany({
          where: { tenantId, billingMode: 'stripe' },
          data: { billingMode: 'manual', stripeSubscriptionItemId: null, nextChargeAt: next },
        });
        break;
      }
    }
    await this.trace(tenantId, 'admin.tenant.consistency_fixed', meta, { code });
    return this.consistency(tenantId);
  }

  // ============================================== pagos a mano y extras

  async voidPayment(
    tenantId: string,
    paymentId: string,
    reason: string,
    meta: Meta,
  ): Promise<TenantSubscriptionPaymentDto> {
    await this.tenantOrThrow(tenantId);
    const res = await this.saasBilling.voidManualPayment({ tenantId, paymentId, reason });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.saas_payment_voided',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { paymentId, amount: res.amount, reason },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return res;
  }

  async updateAddon(
    tenantId: string,
    assignmentId: string,
    input: UpdateTenantAddonInput,
    meta: Meta,
  ) {
    await this.tenantOrThrow(tenantId);
    const summary = await this.addons.updateAssignment(tenantId, assignmentId, input);
    await this.trace(tenantId, 'admin.saas_addon.updated', meta, {
      assignmentId,
      fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
    });
    return summary;
  }

  /** «Cobrar ahora» un extra desde la ficha (el mismo cobro que la bandeja «Hoy»). */
  async chargeAddonNow(tenantId: string, assignmentId: string, provider: string, meta: Meta) {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: assignmentId, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    await this.today.chargeAddon(
      assignmentId,
      provider,
      {
        superAdminId: meta.superAdminId,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
      { allowEarly: true },
    );
    return this.addons.billingSummary(tenantId);
  }
}
