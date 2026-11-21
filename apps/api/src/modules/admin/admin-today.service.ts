import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { adminTodayUrgentCounts } from '@storageos/shared';
import { Queue } from 'bullmq';

import { TtlCache } from '../../common/cache/ttl-cache';
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
import {
  type TodayFingerprint,
  todayFingerprintOf,
  todayReappearReason,
} from './today-fingerprint';

import type {
  AdminAddonChargeDueDto,
  AdminAtRiskDto,
  AdminFailedWebhooksDto,
  AdminManualRenewalDueDto,
  AdminOpenTicketDto,
  AdminStaleSuspendedAddonDto,
  AdminTodayDto,
  AdminTodayKpisDto,
  AdminTodaySnoozeDto,
  CreateTodaySnoozeInput,
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
/** Cuánto vale la bandeja guardada (contador del menú y tarea de avisos). */
const TODAY_CACHE_MS = process.env.NODE_ENV === 'test' ? 0 : 30_000;
/** Fallidos recientes de las colas: los de más atrás ya no son «hoy». */
const FAILED_JOBS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Cuántos fallidos mira de cada cola (los más nuevos primero). */
const FAILED_JOBS_SCAN = 500;

/**
 * Bandeja «Hoy» del super admin: acciones pendientes del día. Reutiliza
 * `getAtRisk` (trials/past_due) y los seguimientos vencidos, y añade los
 * **cobros de add-ons pendientes** (add-ons de tenants que pagan el plan por
 * Stripe → el add-on se cobra a mano cada mes y no lo dispara ningún vencimiento
 * de Stripe). Cobrarlo desde aquí avanza el `next_charge_at` un mes.
 */
@Injectable()
export class AdminTodayService {
  private readonly logger = new Logger(AdminTodayService.name);
  private readonly queues: Queue[];
  private readonly cache = new TtlCache<AdminTodayDto>(TODAY_CACHE_MS);

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

  /**
   * La bandeja «Hoy». Se guarda 30 s en memoria para el contador del menú y la
   * tarea de avisos; la página la pide fresca (`fresh`) y las acciones de aquí
   * (apartar, cobrar) la invalidan.
   */
  getToday(options: { fresh?: boolean } = {}): Promise<AdminTodayDto> {
    if (options.fresh) this.cache.clear();
    return this.cache.get('today', () => this.buildToday());
  }

  /** Solo el número de urgentes (contador del menú), de la bandeja guardada. */
  async getUrgentCount(): Promise<number> {
    return (await this.getToday()).urgentCount;
  }

  /** Olvida la bandeja guardada tras un cambio (apartar, recuperar, cobrar). */
  invalidate(): void {
    this.cache.clear();
  }

  private async buildToday(): Promise<AdminTodayDto> {
    const now = new Date();
    const failedSections: string[] = [];
    // Cada sección falla por separado: sin ella la bandeja sigue y avisa.
    const safe = <T>(name: string, load: () => Promise<T>, fallback: T): Promise<T> =>
      load().catch((err: unknown) => {
        this.logger.warn(`«Hoy»: no se pudo cargar ${name}: ${(err as Error).message}`);
        failedSections.push(name);
        return fallback;
      });
    const emptyAtRisk: AdminAtRiskDto = {
      trialExpiring: [],
      pastDue: [],
      inactive: [],
      lowHealth: [],
      snoozedCount: 0,
    };
    const emptyKpis: AdminTodayKpisDto = {
      mrr: 0,
      collected7d: 0,
      collectedPrev7d: 0,
      mrrPrevMonth: null,
      newPrevMonthToDate: 0,
      pending: 0,
      trials: 0,
      suspended: 0,
      newThisMonth: 0,
    };
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
      snoozeRows,
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
      safe('addonCharges', () => this.addonChargesDue(now), []),
      safe('manualRenewalsDue', () => this.manualRenewalsDue(now), []),
      safe('staleSuspendedAddons', () => this.staleSuspendedAddons(now), []),
      safe('atRisk', () => this.tenants.getAtRisk(), emptyAtRisk),
      safe('followups', () => this.followups.listPending(), []),
      safe('openTickets', () => this.openTickets(now), []),
      safe('failedJobs', () => this.countFailedJobs(now), 0),
      safe('failedWebhooks', () => this.failedWebhooks(now), []),
      safe('aeatIssues', () => this.ops.aeatIssues(now), []),
      safe('certificatesExpiring', () => this.ops.certificatesExpiring(now), []),
      safe('holdedReview', () => this.ops.holdedReview(), []),
      safe('devicesOffline', () => this.ops.devicesOffline(now), []),
      safe('crons', () => this.ops.crons(now), []),
      safe('pendingApprovals', () => this.approvals.pending(), []),
      safe('expiringOverrides', () => this.featureExpiry.expiringSoon(now), []),
      safe('kpis', () => this.activityService.kpis(now), emptyKpis),
      safe(
        'activity',
        () => this.activityService.activity(new Date(now.getTime() - 48 * 3_600_000), now),
        [],
      ),
      safe('businessGoals', () => this.business.getGoals(), null),
      safe('snoozes', () => this.extras.snoozeRecords(now), []),
      safe('newLeads', () => this.extras.newLeads(now), []),
      safe('leadFollowupsDue', () => this.leads.followupsDue(now), []),
      safe('domainsReady', () => this.extras.domainsReady(), []),
      safe('incompleteInvoices', () => this.extras.incompleteInvoices(now), []),
      safe('rgpdOverdue', () => this.extras.rgpdOverdue(now), []),
      safe('npsNegative', () => this.extras.npsNegative(now), []),
      safe('activationStalled', () => this.extras.activationStalled(now), []),
      safe('workload', () => this.extras.workload(), []),
      safe('done', () => this.extras.done(now), {
        ticketsAnswered: 0,
        followupsDone: 0,
        actions: [],
      }),
    ]);
    // Lo apartado por el equipo no sale hasta que venza, salvo que empeore:
    // entonces vuelve con el motivo.
    const snoozedBy = new Map(snoozeRows.map((s) => [`${s.kind}:${s.ref}`, s]));
    const reappearedIds = new Set<string>();
    const keep = <T extends object>(
      items: T[],
      kind: TodaySnoozeKind,
      ref: (item: T) => string,
    ): T[] =>
      items.flatMap((item) => {
        const snoozed = snoozedBy.get(`${kind}:${ref(item)}`);
        if (!snoozed) return [item];
        const reason = todayReappearReason(
          kind,
          snoozed.fingerprint,
          todayFingerprintOf(kind, item),
        );
        if (!reason) return [];
        reappearedIds.add(snoozed.id);
        return [{ ...item, reappeared: true, reappearedReason: reason }];
      });
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
      trialsExpiring: await safe(
        'trialUsage',
        () => this.extras.withTrialUsage(keep(atRisk.trialExpiring, 'trial', (t) => t.id)),
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

    // La misma cuenta que la web usa en las pestañas: siempre cuadran.
    const urgentCount = adminTodayUrgentCounts({
      ...lists,
      followupsDue,
      failedJobs,
      pendingApprovals,
    }).total;
    // Lo que ha vuelto a salir ya no está «apartado».
    const snoozes: AdminTodaySnoozeDto[] = snoozeRows
      .filter((s) => !reappearedIds.has(s.id))
      .map((s) => ({ id: s.id, kind: s.kind, ref: s.ref, label: s.label, until: s.until }));
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
      failedSections,
      urgentCount,
    };
  }

  /**
   * Aparta un aviso guardando cómo estaba: si después empeora, vuelve a salir.
   * Si no se puede calcular la huella se aparta igual (sin volver antes).
   */
  async snooze(input: CreateTodaySnoozeInput, superAdminId: string): Promise<void> {
    const fingerprint = await this.currentFingerprint(input.kind, input.ref).catch(
      (err: unknown) => {
        this.logger.warn(`«Hoy»: huella de ${input.kind}: ${(err as Error).message}`);
        return null;
      },
    );
    await this.extras.snooze(input, superAdminId, fingerprint);
    this.invalidate();
  }

  async unsnooze(id: string): Promise<void> {
    await this.extras.unsnooze(id);
    this.invalidate();
  }

  /** Cómo está ahora el aviso que se va a apartar (solo los tipos con huella). */
  private async currentFingerprint(
    kind: TodaySnoozeKind,
    ref: string,
  ): Promise<TodayFingerprint | null> {
    const now = new Date();
    const pick = <T extends object>(items: T[], match: (item: T) => boolean) => {
      const item = items.find(match);
      return item ? todayFingerprintOf(kind, item) : null;
    };
    switch (kind) {
      case 'ticket':
        return pick(await this.openTickets(now), (t) => t.id === ref);
      case 'past_due':
        return pick((await this.tenants.getAtRisk()).pastDue, (t) => t.id === ref);
      case 'webhook':
        return pick(await this.failedWebhooks(now), (w) => w.tenantId === ref);
      case 'device':
        return pick(await this.ops.devicesOffline(now), (t) => t.tenantId === ref);
      case 'aeat':
        return pick(await this.ops.aeatIssues(now), (t) => t.tenantId === ref);
      case 'holded':
        return pick(await this.ops.holdedReview(), (t) => t.tenantId === ref);
      case 'rgpd':
        return pick(await this.extras.rgpdOverdue(now), (t) => t.tenantId === ref);
      case 'invoice_data':
        return pick(await this.extras.incompleteInvoices(now), (t) => t.tenantId === ref);
      case 'addon_charge':
        return pick(await this.addonChargesDue(now), (c) => c.tenantAddonId === ref);
      case 'certificate':
        return pick(await this.ops.certificatesExpiring(now), (c) => c.id === ref);
      case 'renewal':
        return pick(await this.manualRenewalsDue(now), (r) => r.tenantId === ref);
      default:
        return null;
    }
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
            lastTenantMessageAt: since.toISOString(),
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
   * (agotaron los reintentos) que siguen rotas: cada webhook cuenta solo los
   * fallos posteriores a su última entrega correcta. Si la integración ya
   * vuelve a funcionar, el tenant no sale.
   */
  private async failedWebhooks(now: Date): Promise<AdminFailedWebhooksDto[]> {
    const since = new Date(now.getTime() - 7 * MS_PER_DAY);
    const groups = await this.admin.$queryRaw<
      { tenant_id: string; failed: number; last_failed_at: Date }[]
    >`
      SELECT d.tenant_id, count(*)::int AS failed, max(d.created_at) AS last_failed_at
      FROM webhook_deliveries d
      LEFT JOIN (
        SELECT webhook_id, max(created_at) AS last_ok
        FROM webhook_deliveries
        WHERE status = 'success'
        GROUP BY webhook_id
      ) ok ON ok.webhook_id = d.webhook_id
      WHERE d.status = 'failed'
        AND d.created_at >= ${since}
        AND (ok.last_ok IS NULL OR d.created_at > ok.last_ok)
      GROUP BY d.tenant_id`;
    if (groups.length === 0) return [];
    const tenantIds = groups.map((g) => g.tenant_id);
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
      .filter((g) => names.has(g.tenant_id))
      .map((g) => ({
        tenantId: g.tenant_id,
        tenantName: names.get(g.tenant_id) ?? '—',
        failedCount: g.failed,
        lastFailedAt: new Date(g.last_failed_at).toISOString(),
        lastError: errors.get(g.tenant_id) ?? null,
      }))
      .sort((a, b) => b.failedCount - a.failedCount);
  }

  /**
   * Trabajos de las colas que han fallado en las últimas 24 h. Los fallidos se
   * guardan 30 días: contarlos todos dejaba el aviso encendido un mes.
   */
  private async countFailedJobs(now: Date): Promise<number> {
    const since = now.getTime() - FAILED_JOBS_WINDOW_MS;
    const perQueue = await Promise.all(
      this.queues.map(async (q) => {
        const jobs = await q.getFailed(0, FAILED_JOBS_SCAN - 1);
        return jobs.filter(
          (job) => (job?.finishedOn ?? job?.processedOn ?? job?.timestamp ?? 0) >= since,
        ).length;
      }),
    );
    return perQueue.reduce((sum, n) => sum + n, 0);
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
        addon: { isSystem: false }, // los trasteros de más van con la cuota
        // Con la cuota domiciliada por SEPA los extras ya van en la remesa: no
        // se cobran aparte (se cobrarían dos veces).
        tenant: {
          deletedAt: null,
          billingExempt: false,
          // Un tenant dado de baja ya no se cobra (aunque no esté borrado).
          status: { not: 'cancelled' },
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
        addon: { select: { name: true, isSystem: true } },
        tenant: {
          select: {
            currency: true,
            deletedAt: true,
            status: true,
            billingExempt: true,
            subscription: { select: { billingMode: true } },
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Add-on no encontrado' });
    }
    if (row.addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Los trasteros de más se cobran con la cuota, no aparte.',
      });
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
    if (
      chargedAlone ||
      row.tenant.deletedAt ||
      row.tenant.status === 'cancelled' ||
      row.tenant.billingExempt
    ) {
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
    return this.getToday({ fresh: true });
  }
}
