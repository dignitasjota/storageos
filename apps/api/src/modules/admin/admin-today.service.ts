import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';

import { todayInTimezone } from '../../common/format';
import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { amountToCharge, platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';
import {
  QUEUE_AUTOMATIONS,
  QUEUE_BILLING,
  QUEUE_COMMUNICATIONS,
  QUEUE_DUNNING,
  QUEUE_EMAIL,
  QUEUE_PAYMENTS,
  QUEUE_REPORTS,
  QUEUE_VERIFACTU,
  QUEUE_WEBHOOKS,
} from '../queues/queue-names';

import { AdminActivityService } from './admin-activity.service';
import { AdminApprovalsService } from './admin-approvals.service';
import { AdminBusinessService } from './admin-business.service';
import { AdminOpsHealthService } from './admin-ops-health.service';
import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminTodayExtrasService } from './admin-today-extras.service';
import { FeatureExpiryService } from './feature-expiry.service';
import { PlatformLeadsService } from './leads/platform-leads.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type {
  AdminAddonChargeDueDto,
  AdminFailedWebhooksDto,
  AdminManualRenewalDueDto,
  AdminOpenTicketDto,
  AdminStaleSuspendedAddonDto,
  AdminTodayDto,
  TodaySnoozeKind,
} from '@storageos/shared';

/** Suma N meses conservando el fin de mes (evita desbordes de día). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** Un tenant dado de baja ya no tiene a quién contestar; uno suspendido sí. */
const LIVE_TENANT_FOR_TICKETS = { deletedAt: null, status: { not: 'cancelled' as const } };

/** Orden de prioridad de los tickets (mayor = antes). */
const PRIORITY_ORDER: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bandeja «Hoy» del super admin: acciones pendientes del día. Reutiliza
 * `getAtRisk` (trials/past_due) y los seguimientos vencidos, y añade los
 * **cobros de add-ons pendientes** (add-ons de tenants que pagan el plan por
 * Stripe → el add-on se cobra a mano cada mes y no lo dispara ningún vencimiento
 * de Stripe). Cobrarlo desde aquí avanza el `next_charge_at` un mes.
 */
@Injectable()
export class AdminTodayService {
  private readonly queues: Queue[];

  constructor(
    private readonly approvals: AdminApprovalsService,
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly followups: AdminTenantFollowupsService,
    private readonly billing: BillingSaasService,
    private readonly ops: AdminOpsHealthService,
    private readonly featureExpiry: FeatureExpiryService,
    private readonly activityService: AdminActivityService,
    private readonly business: AdminBusinessService,
    private readonly audit: SuperAdminAuditService,
    private readonly extras: AdminTodayExtrasService,
    private readonly leads: PlatformLeadsService,
    @InjectQueue(QUEUE_BILLING) billingQueue: Queue,
    @InjectQueue(QUEUE_DUNNING) dunningQueue: Queue,
    @InjectQueue(QUEUE_PAYMENTS) paymentsQueue: Queue,
    @InjectQueue(QUEUE_VERIFACTU) verifactuQueue: Queue,
    @InjectQueue(QUEUE_EMAIL) emailQueue: Queue,
    @InjectQueue(QUEUE_COMMUNICATIONS) communicationsQueue: Queue,
    @InjectQueue(QUEUE_AUTOMATIONS) automationsQueue: Queue,
    @InjectQueue(QUEUE_REPORTS) reportsQueue: Queue,
    @InjectQueue(QUEUE_WEBHOOKS) webhooksQueue: Queue,
  ) {
    this.queues = [
      billingQueue,
      dunningQueue,
      paymentsQueue,
      verifactuQueue,
      emailQueue,
      communicationsQueue,
      automationsQueue,
      reportsQueue,
      webhooksQueue,
    ];
  }

  async getToday(): Promise<AdminTodayDto> {
    const now = new Date();
    const [
      addonCharges,
      manualRenewalsDue,
      staleSuspendedAddons,
      atRisk,
      pendingFollowups,
      openTickets,
      failedJobs,
      failedWebhooks,
      aeatIssues,
      certificatesExpiring,
      holdedReview,
      devicesOffline,
      crons,
      pendingApprovals,
      expiringOverrides,
      kpis,
      activity,
      goals,
      snoozes,
      leadsAll,
      leadFollowupsAll,
      domainsAll,
      invoicesAll,
      rgpdAll,
      npsAll,
      activationAll,
      workload,
      done,
    ] = await Promise.all([
      this.addonChargesDue(now),
      this.manualRenewalsDue(now),
      this.staleSuspendedAddons(now),
      this.tenants.getAtRisk(),
      this.followups.listPending(),
      this.openTickets(now),
      this.countFailedJobs(),
      this.failedWebhooks(now),
      this.ops.aeatIssues(now),
      this.ops.certificatesExpiring(now),
      this.ops.holdedReview(),
      this.ops.devicesOffline(now),
      this.ops.crons(now),
      this.approvals.pending(),
      this.featureExpiry.expiringSoon(now),
      this.activityService.kpis(now),
      this.activityService.activity(new Date(now.getTime() - 48 * 3_600_000), now),
      this.business.getGoals().catch(() => null),
      this.extras.snoozes(now),
      this.extras.newLeads(now),
      this.leads.followupsDue(now),
      this.extras.domainsReady(),
      this.extras.incompleteInvoices(now),
      this.extras.rgpdOverdue(now),
      this.extras.npsNegative(now),
      this.extras.activationStalled(now),
      this.extras.workload(),
      this.extras.done(now),
    ]);
    // Lo apartado por el equipo no sale hasta que venza.
    const apart = new Set(snoozes.map((s) => `${s.kind}:${s.ref}`));
    const keep = <T>(items: T[], kind: TodaySnoozeKind, ref: (item: T) => string): T[] =>
      items.filter((item) => !apart.has(`${kind}:${ref(item)}`));
    // Progreso de los objetivos del negocio (solo si hay alguno puesto).
    const businessGoals =
      goals && (goals.progress.mrr || goals.progress.signups || goals.progress.trialConversion)
        ? goals
        : null;
    const overdueCrons = crons.filter((c) => c.overdue);
    // Solo los que tocan hoy o ya pasaron (antes salían todos los pendientes,
    // también los de dentro de semanas, como «vencidos» y urgentes).
    const todayIso = todayInTimezone('Europe/Madrid', now).toISOString().slice(0, 10);
    const followupsDue = pendingFollowups.filter((f) => f.dueDate <= todayIso);
    const weekIso = new Date(todayInTimezone('Europe/Madrid', now).getTime() + 7 * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    const followupsUpcoming = pendingFollowups.filter(
      (f) => f.dueDate > todayIso && f.dueDate <= weekIso,
    );

    const lists = {
      addonCharges: keep(addonCharges, 'addon_charge', (c) => c.tenantAddonId),
      manualRenewalsDue: keep(manualRenewalsDue, 'renewal', (r) => r.tenantId),
      trialsExpiring: await this.extras.withTrialUsage(
        keep(atRisk.trialExpiring, 'trial', (t) => t.id),
      ),
      // Quien más debe, primero.
      pastDue: keep(atRisk.pastDue, 'past_due', (t) => t.id).sort(
        (a, b) => (b.owedAmount ?? 0) - (a.owedAmount ?? 0),
      ),
      staleSuspendedAddons: keep(staleSuspendedAddons, 'stale_addon', (s) => s.tenantAddonId),
      openTickets: keep(openTickets, 'ticket', (t) => t.id),
      failedWebhooks: keep(failedWebhooks, 'webhook', (w) => w.tenantId),
      aeatIssues: keep(aeatIssues, 'aeat', (t) => t.tenantId),
      certificatesExpiring: keep(certificatesExpiring, 'certificate', (c) => c.id),
      holdedReview: keep(holdedReview, 'holded', (t) => t.tenantId),
      devicesOffline: keep(devicesOffline, 'device', (t) => t.tenantId),
      overdueCrons: keep(overdueCrons, 'cron', (c) => c.name),
      expiringOverrides: keep(expiringOverrides, 'override', (o) => `${o.tenantId}-${o.feature}`),
      newLeads: keep(leadsAll, 'contact', (c) => c.id),
      leadFollowupsDue: keep(leadFollowupsAll, 'lead_followup', (f) => f.id),
      domainsReady: keep(domainsAll, 'domain', (d) => d.tenantId),
      incompleteInvoices: keep(invoicesAll, 'invoice_data', (t) => t.tenantId),
      rgpdOverdue: keep(rgpdAll, 'rgpd', (t) => t.tenantId),
      npsNegative: keep(npsAll, 'nps', (n) => n.id),
      activationStalled: keep(activationAll, 'activation', (a) => a.tenantId),
    };

    const urgentCount =
      lists.addonCharges.length +
      // Lo que aún tiene días por delante es de «Esta semana», no urgente.
      lists.manualRenewalsDue.filter((r) => r.daysLeft <= 1).length +
      lists.pastDue.length +
      followupsDue.length +
      lists.openTickets.length +
      lists.failedWebhooks.length +
      (failedJobs > 0 ? 1 : 0) +
      lists.aeatIssues.length +
      lists.certificatesExpiring.filter((c) => c.daysLeft <= 15).length +
      lists.holdedReview.length +
      lists.devicesOffline.length +
      lists.overdueCrons.length +
      pendingApprovals.length +
      lists.expiringOverrides.filter((o) => o.daysLeft <= 1).length +
      lists.newLeads.length +
      lists.leadFollowupsDue.length +
      lists.domainsReady.length +
      lists.rgpdOverdue.length;
    return {
      date: now.toISOString(),
      ...lists,
      followupsDue,
      followupsUpcoming,
      failedJobs,
      pendingApprovals,
      workload,
      snoozes,
      done,
      kpis,
      activity,
      businessGoals,
      urgentCount,
    };
  }

  /** Tickets de soporte esperando respuesta del admin (status open). */
  private async openTickets(now: Date): Promise<AdminOpenTicketDto[]> {
    const rows = await this.admin.supportTicket.findMany({
      where: { status: 'open', tenant: LIVE_TENANT_FOR_TICKETS },
      select: {
        id: true,
        tenantId: true,
        subject: true,
        priority: true,
        createdAt: true,
        tenant: { select: { name: true } },
        assignedAdminId: true,
        assignedAdmin: { select: { fullName: true } },
        // Lo que espera el admin cuenta desde el último mensaje del tenant
        // (`updatedAt` cambia también con un cambio de prioridad o una nota).
        messages: {
          where: { authorUserId: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    return rows
      .map((r) => {
        const since = r.messages[0]?.createdAt ?? r.createdAt;
        return {
          since,
          dto: {
            id: r.id,
            tenantId: r.tenantId,
            tenantName: r.tenant.name,
            subject: r.subject,
            priority: r.priority,
            waitingDays: Math.floor((now.getTime() - since.getTime()) / MS_PER_DAY),
            assignedAdminId: r.assignedAdminId,
            assignedAdminName: r.assignedAdmin?.fullName ?? null,
          },
        };
      })
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.dto.priority] ?? 0;
        const pb = PRIORITY_ORDER[b.dto.priority] ?? 0;
        return pb - pa || a.since.getTime() - b.since.getTime();
      })
      .map((x) => x.dto);
  }

  /**
   * Tenants con entregas de webhook salientes en `failed` en los últimos 7 días
   * (agotaron los reintentos): su integración está rota y conviene avisarles.
   */
  private async failedWebhooks(now: Date): Promise<AdminFailedWebhooksDto[]> {
    const since = new Date(now.getTime() - 7 * MS_PER_DAY);
    const groups = await this.admin.webhookDelivery.groupBy({
      by: ['tenantId'],
      where: { status: 'failed', createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    if (groups.length === 0) return [];
    const tenantIds = groups.map((g) => g.tenantId);
    const [tenants, lastErrors] = await Promise.all([
      this.admin.tenant.findMany({
        where: { id: { in: tenantIds }, deletedAt: null, status: { not: 'cancelled' } },
        select: { id: true, name: true },
      }),
      this.admin.webhookDelivery.findMany({
        where: { tenantId: { in: tenantIds }, status: 'failed', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        distinct: ['tenantId'],
        select: { tenantId: true, errorMessage: true, statusCode: true },
      }),
    ]);
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    const errors = new Map(
      lastErrors.map((e) => [
        e.tenantId,
        e.errorMessage ?? (e.statusCode != null ? `HTTP ${e.statusCode}` : null),
      ]),
    );
    return groups
      .filter((g) => names.has(g.tenantId))
      .map((g) => ({
        tenantId: g.tenantId,
        tenantName: names.get(g.tenantId) ?? '—',
        failedCount: g._count._all,
        lastFailedAt: (g._max.createdAt ?? now).toISOString(),
        lastError: errors.get(g.tenantId) ?? null,
      }))
      .sort((a, b) => b.failedCount - a.failedCount);
  }

  /** Nº total de jobs BullMQ en estado failed (colas que necesitan atención). */
  private async countFailedJobs(): Promise<number> {
    const counts = await Promise.all(this.queues.map((q) => q.getJobCounts('failed')));
    return counts.reduce((sum, c) => sum + (c.failed ?? 0), 0);
  }

  /**
   * Suscripciones de pago MANUAL de un plan de pago cuyo periodo vence en ≤7
   * días o ya venció: hay que cobrarlas a mano antes de que caduquen. Las de
   * Stripe, SEPA y Redsys se cobran solas y las del plan gratis no se cobran.
   */
  private async manualRenewalsDue(now: Date): Promise<AdminManualRenewalDueDto[]> {
    const cutoff = new Date(now.getTime() + 7 * MS_PER_DAY);
    const rows = await this.admin.tenantSubscription.findMany({
      where: {
        billingMode: 'manual',
        stripeSubscriptionId: null,
        status: 'active',
        currentPeriodEnd: { lte: cutoff },
        plan: { priceMonthly: { gt: 0 } },
        // Las cuentas exentas no se cobran nunca → no deben aparecer como
        // «renovación manual pendiente» (su fecha de fin es irrelevante).
        tenant: { deletedAt: null, billingExempt: false, status: { in: ['active', 'trial'] } },
      },
      select: { tenantId: true, currentPeriodEnd: true, tenant: { select: { name: true } } },
      orderBy: { currentPeriodEnd: 'asc' },
    });
    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      currentPeriodEnd: r.currentPeriodEnd.toISOString(),
      daysLeft: Math.ceil((r.currentPeriodEnd.getTime() - now.getTime()) / MS_PER_DAY),
    }));
  }

  /** Add-ons suspendidos hace >30 días: candidatos a quitar definitivamente. */
  private async staleSuspendedAddons(now: Date): Promise<AdminStaleSuspendedAddonDto[]> {
    const cutoff = new Date(now.getTime() - 30 * MS_PER_DAY);
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: { suspendedAt: { not: null, lt: cutoff }, tenant: { deletedAt: null } },
      select: {
        id: true,
        tenantId: true,
        suspendedAt: true,
        addon: { select: { name: true } },
        tenant: { select: { name: true } },
      },
      orderBy: { suspendedAt: 'asc' },
    });
    return rows.map((r) => ({
      tenantAddonId: r.id,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      addonName: r.addon.name,
      suspendedAt: (r.suspendedAt ?? now).toISOString(),
      daysSuspended: Math.floor((now.getTime() - (r.suspendedAt ?? now).getTime()) / MS_PER_DAY),
    }));
  }

  /**
   * Add-ons en modo MANUAL con `next_charge_at <= ahora` (los de Stripe los cobra
   * Stripe y tienen `next_charge_at` nulo → quedan fuera por el filtro de fecha).
   * Incluye tanto tenants de plan Stripe con add-on manual como tenants 100%
   * manuales: en ambos casos el add-on se cobra a mano desde aquí.
   */
  private async addonChargesDue(now: Date): Promise<AdminAddonChargeDueDto[]> {
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: {
        nextChargeAt: { lte: now },
        suspendedAt: null, // los suspendidos por impago no se cobran
        billingMode: { not: 'stripe' }, // manual (o legacy null); los de Stripe no
        // Con la cuota domiciliada por SEPA los extras ya van en la remesa: no
        // se cobran aparte (se cobrarían dos veces).
        tenant: {
          deletedAt: null,
          billingExempt: false,
          // Con la cuota domiciliada o cobrada sola con tarjeta, los extras van
          // en el mismo cargo.
          NOT: { subscription: { billingMode: { in: ['sepa', 'redsys'] } } },
        },
      },
      include: {
        addon: { select: { name: true } },
        tenant: { select: { name: true, currency: true } },
      },
      orderBy: { nextChargeAt: 'asc' },
    });
    const pricing = await platformPricing(this.admin);
    return rows.map((r) => {
      const due = r.nextChargeAt ?? now;
      const overdueDays = Math.max(0, Math.floor((now.getTime() - due.getTime()) / MS_PER_DAY));
      return {
        tenantAddonId: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        addonName: r.addon.name,
        amount: amountToCharge(Number(r.priceMonthly) * r.quantity, pricing),
        currency: r.tenant.currency,
        nextChargeAt: due.toISOString(),
        overdueDays,
      };
    });
  }

  /**
   * Registra el cobro manual de un add-on (sin extender el periodo) y avanza su
   * `next_charge_at` un mes desde la fecha que tocaba: cobrar con retraso no
   * regala días. Se comprueba de nuevo que sigue siendo cobrable, porque la
   * bandeja pudo pintarse antes de que pasara a cobrarse solo.
   */
  async chargeAddon(
    tenantAddonId: string,
    provider: string,
    actor: { superAdminId: string; ipAddress: string | null; userAgent: string | null },
  ): Promise<AdminTodayDto> {
    const row = await this.admin.tenantSubscriptionAddon.findUnique({
      where: { id: tenantAddonId },
      include: {
        addon: { select: { name: true } },
        tenant: {
          select: {
            currency: true,
            deletedAt: true,
            billingExempt: true,
            subscription: { select: { billingMode: true } },
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Add-on no encontrado' });
    }
    // Pudo suspenderse entre que se pintó la bandeja «Hoy» y este cobro.
    if (row.suspendedAt) {
      throw new BadRequestException({
        code: 'addon_suspended',
        message: 'El add-on está suspendido; reactívalo antes de cobrarlo.',
      });
    }
    const chargedAlone =
      row.billingMode === 'stripe' ||
      row.tenant.subscription?.billingMode === 'sepa' ||
      row.tenant.subscription?.billingMode === 'redsys';
    if (chargedAlone || row.tenant.deletedAt || row.tenant.billingExempt) {
      throw new ConflictException({
        code: 'addon_not_chargeable',
        message: 'Este extra ya no se cobra a mano: actualiza la página.',
      });
    }
    const due = row.nextChargeAt;
    if (!due || due.getTime() > Date.now()) {
      throw new ConflictException({
        code: 'addon_already_charged',
        message: 'Este cobro ya está registrado.',
      });
    }
    // Reserva el cobro: de dos clics o dos personas, solo pasa uno.
    const next = addMonths(due, 1);
    const claimed = await this.admin.tenantSubscriptionAddon.updateMany({
      where: { id: tenantAddonId, nextChargeAt: due },
      data: { nextChargeAt: next },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        code: 'addon_already_charged',
        message: 'Este cobro ya está registrado.',
      });
    }
    // Con precios +IVA se cobra el precio más el IVA.
    const amount = amountToCharge(
      Number(row.priceMonthly) * row.quantity,
      await platformPricing(this.admin),
    );
    try {
      await this.billing.recordManualPayment({
        tenantId: row.tenantId,
        provider,
        amount,
        currency: row.tenant.currency,
        durationMonths: 1,
        extendsPeriod: false, // cobro del add-on: NO toca el periodo del plan
        description: `Add-on: ${row.addon.name}`,
      });
    } catch (err) {
      await this.admin.tenantSubscriptionAddon.updateMany({
        where: { id: tenantAddonId, nextChargeAt: next },
        data: { nextChargeAt: due },
      });
      throw err;
    }
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.saas_addon.charged',
      targetType: 'tenant_addon',
      targetId: tenantAddonId,
      targetTenantId: row.tenantId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      changes: { addon: row.addon.name, amount, provider },
    });
    return this.getToday();
  }
}
