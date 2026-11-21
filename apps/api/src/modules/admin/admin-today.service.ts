import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  type AdminTodayVisitSnapshotItem,
  adminTodayUrgentCounts,
  adminTodayVisitItems,
  adminTodayVisitSummary,
  DEFAULT_SUPPORT_RESPONSE_HOURS,
} from '@storageos/shared';
import { Job, Queue } from 'bullmq';

import { TtlCache } from '../../common/cache/ttl-cache';
import { todayInTimezone } from '../../common/format';
import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { PlatformDunningService } from '../billing-saas/platform-dunning.service';
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
import { SupportAgilityService } from './support-agility.service';
import { SupportTicketsService } from './support-tickets.service';
import {
  type TodayFingerprint,
  todayFingerprintOf,
  todayReappearReason,
} from './today-fingerprint';

import type {
  AdminAddonChargeDueDto,
  AdminAtRiskDto,
  AdminAtRiskTenantDto,
  AdminFailedWebhooksDto,
  AdminManualRenewalDueDto,
  AdminOpenTicketDto,
  AdminStaleSuspendedAddonDto,
  AdminTodayBatchResultDto,
  AdminTodayDto,
  AdminTodayFailedJobDto,
  AdminTodayKpisDto,
  AdminTodayMoneyAtRiskDto,
  AdminTodaySnoozeDto,
  AdminTodayVisitDto,
  CreateTodaySnoozeInput,
  SupportTicketPriorityValue,
  TodayBatchInput,
  TodayFailedJobsInput,
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
/** Cuántos fallidos de las colas se enseñan en «Hoy». */
const FAILED_JOBS_SHOWN = 20;
/** Un lead asignado sale como «sin atender» pasadas estas horas sin respuesta. */
const ASSIGNED_LEAD_HOURS = 24;
/** Las pruebas que terminan en estos días cuentan en el dinero en juego. */
const TRIAL_AT_RISK_DAYS = 3;
/** Los «revisados» de más de 30 días ya no sirven (los fallidos se guardan 30). */
const REVIEWED_JOBS_KEEP_DAYS = 30;
/** Cuántas claves se guardan en la foto de la última visita. */
const VISIT_SNAPSHOT_MAX = 1000;

type ResponseTargets = Record<SupportTicketPriorityValue, number>;

/** Quién hace una acción de «Hoy». */
export interface TodayActor {
  superAdminId: string;
  role: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Mensaje legible de un error (el de la API si lo trae). */
function errorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Error desconocido';
}

/** Cuándo termina una prueba (ms); sin fecha, al final. */
const trialEnd = (t: AdminAtRiskTenantDto): number =>
  t.since ? new Date(t.since).getTime() : Number.MAX_SAFE_INTEGER;

/** Cuánto se usa una prueba: contratos, trasteros y locales (en ese orden de peso). */
const trialUsageScore = (t: AdminAtRiskTenantDto): number =>
  t.usage ? t.usage.contracts * 1000 + t.usage.units * 10 + t.usage.facilities : 0;

/** Cuándo falló un trabajo de una cola (ms). */
const jobFailedAt = (job: Job): number =>
  job?.finishedOn ?? job?.processedOn ?? job?.timestamp ?? 0;

/** Primera línea del motivo del fallo, recortada. */
function shortReason(reason: string | undefined | null): string | null {
  const line = (reason ?? '').split('\n')[0]?.trim() ?? '';
  if (!line) return null;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

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
    private readonly agility: SupportAgilityService,
    private readonly tickets: SupportTicketsService,
    private readonly dunning: PlatformDunningService,
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
    // El plazo de respuesta de cada prioridad (sin datos, el de por defecto).
    const targetsP = safe('responseTargets', () => this.responseTargets(now), {
      ...DEFAULT_SUPPORT_RESPONSE_HOURS,
    } as ResponseTargets);
    const [
      addonCharges,
      manualRenewalsDue,
      staleSuspendedAddons,
      atRisk,
      pendingFollowups,
      openTickets,
      failedJobsAll,
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
      paymentFailuresAll,
      inactiveAll,
    ] = await Promise.all([
      safe('addonCharges', () => this.addonChargesDue(now), []),
      safe('manualRenewalsDue', () => this.manualRenewalsDue(now), []),
      safe('staleSuspendedAddons', () => this.staleSuspendedAddons(now), []),
      safe('atRisk', () => this.tenants.getAtRisk(), emptyAtRisk),
      safe('followups', () => this.followups.listPending(), []),
      safe('openTickets', async () => this.openTickets(now, await targetsP), []),
      safe('failedJobs', () => this.recentFailedJobs(now), [] as AdminTodayFailedJobDto[]),
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
      safe('paymentFailures', () => this.extras.paymentFailures(now), []),
      safe('inactivePaying', () => this.extras.inactivePaying(now), []),
    ]);
    const responseTargets = await targetsP;
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

    // Orden por importancia, sección a sección (lo más grave o lo que más
    // dinero mueve, primero).
    const byCount = <T extends { count: number; tenantName: string }>(a: T, b: T) =>
      b.count - a.count || a.tenantName.localeCompare(b.tenantName);
    const trialsKept = keep(atRisk.trialExpiring, 'trial', (t) => t.id);
    const leadsKept = keep(leadsAll, 'contact', (c) => c.id);
    const lists = {
      // Más días de retraso y, a igualdad, más importe.
      addonCharges: keep(addonCharges, 'addon_charge', (c) => c.tenantAddonId).sort(
        (a, b) => b.overdueDays - a.overdueDays || b.amount - a.amount,
      ),
      // Lo que vence antes (o ya venció), primero.
      manualRenewalsDue: keep(manualRenewalsDue, 'renewal', (r) => r.tenantId).sort(
        (a, b) => a.daysLeft - b.daysLeft,
      ),
      // Lo que termina antes y, a igualdad, la que más se usa (más que ganar).
      trialsExpiring: (
        await safe('trialUsage', () => this.extras.withTrialUsage(trialsKept), trialsKept)
      ).sort((a, b) => trialEnd(a) - trialEnd(b) || trialUsageScore(b) - trialUsageScore(a)),
      // Quien más debe, primero.
      pastDue: keep(atRisk.pastDue, 'past_due', (t) => t.id).sort(
        (a, b) => (b.owedAmount ?? 0) - (a.owedAmount ?? 0),
      ),
      staleSuspendedAddons: keep(staleSuspendedAddons, 'stale_addon', (s) => s.tenantAddonId).sort(
        (a, b) => b.daysSuspended - a.daysSuspended,
      ),
      // Ya viene ordenado por lo que vence antes.
      openTickets: keep(openTickets, 'ticket', (t) => t.id),
      failedWebhooks: keep(failedWebhooks, 'webhook', (w) => w.tenantId).sort(
        (a, b) => b.failedCount - a.failedCount,
      ),
      aeatIssues: keep(aeatIssues, 'aeat', (t) => t.tenantId).sort(byCount),
      certificatesExpiring: keep(certificatesExpiring, 'certificate', (c) => c.id).sort(
        (a, b) => a.daysLeft - b.daysLeft,
      ),
      holdedReview: keep(holdedReview, 'holded', (t) => t.tenantId).sort(byCount),
      devicesOffline: keep(devicesOffline, 'device', (t) => t.tenantId).sort(byCount),
      overdueCrons: keep(overdueCrons, 'cron', (c) => c.name),
      expiringOverrides: keep(
        expiringOverrides,
        'override',
        (o) => `${o.tenantId}-${o.feature}`,
      ).sort((a, b) => a.daysLeft - b.daysLeft),
      // Leads: el más antiguo primero. Los asignados solo salen pasadas 24 h
      // sin respuesta; los recientes ya los lleva alguien.
      newLeads: leadsKept
        .filter((l) => !l.assignedToId)
        .sort((a, b) => b.waitingHours - a.waitingHours),
      assignedLeads: leadsKept
        .filter((l) => !!l.assignedToId && l.waitingHours >= ASSIGNED_LEAD_HOURS)
        .sort((a, b) => b.waitingHours - a.waitingHours),
      leadFollowupsDue: keep(leadFollowupsAll, 'lead_followup', (f) => f.id).sort((a, b) =>
        a.dueDate.localeCompare(b.dueDate),
      ),
      domainsReady: keep(domainsAll, 'domain', (d) => d.tenantId),
      incompleteInvoices: keep(invoicesAll, 'invoice_data', (t) => t.tenantId).sort(byCount),
      rgpdOverdue: keep(rgpdAll, 'rgpd', (t) => t.tenantId).sort(byCount),
      // Las notas más bajas, primero.
      npsNegative: keep(npsAll, 'nps', (n) => n.id).sort((a, b) => a.score - b.score),
      // Las más recientes primero: son las que aún se pueden recuperar.
      activationStalled: keep(activationAll, 'activation', (a) => a.tenantId).sort(
        (a, b) => a.daysSinceSignup - b.daysSinceSignup,
      ),
      // Ya vienen de más dinero a menos.
      paymentFailures: keep(paymentFailuresAll, 'payment_failure', (p) => p.tenantId),
      inactivePaying: keep(inactiveAll, 'inactive', (t) => t.tenantId),
    };
    // Lo que paga cada tenant: lo que hay en juego en cada fila.
    const monthly = await safe(
      'monthly',
      () =>
        this.extras.monthlyByTenant([
          ...lists.trialsExpiring.map((t) => t.id),
          ...lists.manualRenewalsDue.map((r) => r.tenantId),
          ...lists.openTickets.map((t) => t.tenantId),
        ]),
      new Map<string, number>(),
    );
    const withMonthly = <T extends object>(items: T[], id: (item: T) => string): T[] =>
      items.map((item) => {
        const value = monthly.get(id(item));
        return value === undefined ? item : { ...item, monthly: value };
      });
    lists.trialsExpiring = withMonthly(lists.trialsExpiring, (t) => t.id);
    lists.manualRenewalsDue = withMonthly(lists.manualRenewalsDue, (r) => r.tenantId);
    lists.openTickets = withMonthly(lists.openTickets, (t) => t.tenantId);

    // Lo que no se revisó de las colas; se enseñan los más recientes.
    const failedJobs = failedJobsAll.length;
    const failedJobsList = failedJobsAll.slice(0, FAILED_JOBS_SHOWN);

    const moneyAtRisk = this.moneyAtRisk(lists, now);

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
      failedJobsList,
      moneyAtRisk,
      responseTargets,
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
      case 'payment_failure':
        return pick(await this.extras.paymentFailures(now), (p) => p.tenantId === ref);
      case 'inactive':
        return pick(await this.extras.inactivePaying(now), (t) => t.tenantId === ref);
      default:
        return null;
    }
  }

  /** El aviso tal como sale en la bandeja ya calculada (sin volver a consultar). */
  private itemFromToday(today: AdminTodayDto, kind: TodaySnoozeKind, ref: string): object | null {
    const find = <T extends object>(items: T[], id: (item: T) => string) =>
      items.find((item) => id(item) === ref) ?? null;
    switch (kind) {
      case 'ticket':
        return find(today.openTickets, (t) => t.id);
      case 'past_due':
        return find(today.pastDue, (t) => t.id);
      case 'webhook':
        return find(today.failedWebhooks, (w) => w.tenantId);
      case 'device':
        return find(today.devicesOffline, (t) => t.tenantId);
      case 'aeat':
        return find(today.aeatIssues, (t) => t.tenantId);
      case 'holded':
        return find(today.holdedReview, (t) => t.tenantId);
      case 'rgpd':
        return find(today.rgpdOverdue, (t) => t.tenantId);
      case 'invoice_data':
        return find(today.incompleteInvoices, (t) => t.tenantId);
      case 'addon_charge':
        return find(today.addonCharges, (c) => c.tenantAddonId);
      case 'certificate':
        return find(today.certificatesExpiring, (c) => c.id);
      case 'renewal':
        return find(today.manualRenewalsDue, (r) => r.tenantId);
      case 'payment_failure':
        return find(today.paymentFailures, (p) => p.tenantId);
      case 'inactive':
        return find(today.inactivePaying, (t) => t.tenantId);
      default:
        return null;
    }
  }

  // ------------------------------------------------------------ en lote

  /**
   * Acción sobre varios avisos a la vez: apartar, asignarme (tickets y leads) o
   * recordar el pago (impagos y cobros rechazados; solo el rol superadmin).
   * Cada aviso va por separado: los que fallan no paran a los demás.
   */
  async batch(input: TodayBatchInput, actor: TodayActor): Promise<AdminTodayBatchResultDto> {
    if (input.action === 'remind' && actor.role !== 'superadmin') {
      throw new ForbiddenException({
        code: 'insufficient_super_admin_role',
        message: 'Esta acción requiere el rol superadmin',
      });
    }
    const result: AdminTodayBatchResultDto = { done: 0, failed: [] };
    // Las huellas para apartar salen de la bandeja de ahora (una sola vez).
    const today = input.action === 'snooze' ? await this.getToday({ fresh: true }) : null;
    for (const item of input.items) {
      const label = item.label ?? item.ref;
      try {
        if (input.action === 'snooze') {
          const found = today ? this.itemFromToday(today, item.kind, item.ref) : null;
          const fingerprint = found
            ? todayFingerprintOf(item.kind, found)
            : await this.currentFingerprint(item.kind, item.ref).catch(() => null);
          await this.extras.snooze(
            { kind: item.kind, ref: item.ref, days: input.days ?? 7, label },
            actor.superAdminId,
            fingerprint,
          );
        } else if (input.action === 'assign') {
          if (item.kind === 'ticket') {
            await this.tickets.assign({
              superAdminId: actor.superAdminId,
              ticketId: item.ref,
              input: { superAdminId: actor.superAdminId },
              meta: { ipAddress: actor.ipAddress, userAgent: actor.userAgent },
            });
          } else if (item.kind === 'contact') {
            await this.leads.update(
              item.ref,
              { assignedToId: actor.superAdminId },
              actor.superAdminId,
            );
          } else {
            throw new BadRequestException({
              code: 'not_assignable',
              message: 'Solo se pueden asignar tickets y leads',
            });
          }
        } else {
          if (item.kind !== 'past_due' && item.kind !== 'payment_failure') {
            throw new BadRequestException({
              code: 'not_remindable',
              message: 'Solo se recuerdan los pagos pendientes',
            });
          }
          await this.dunning.remindNow(item.ref);
          await this.audit.record({
            superAdminId: actor.superAdminId,
            action: 'admin.billing.reminder_sent',
            targetType: 'tenant',
            targetId: item.ref,
            targetTenantId: item.ref,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            changes: { from: 'today_batch' },
          });
        }
        result.done += 1;
      } catch (err) {
        result.failed.push({ ref: item.ref, label, message: errorMessage(err) });
      }
    }
    this.invalidate();
    return result;
  }

  // ------------------------------------------------------ última visita

  /**
   * Resumen «Desde tu última visita» y foto de lo que hay ahora. Lo pide la
   * página al abrirse (una vez); el refresco de cada minuto no la toca.
   */
  async visit(superAdminId: string, now = new Date()): Promise<AdminTodayVisitDto> {
    const today = await this.getToday();
    const items = adminTodayVisitItems(today).slice(0, VISIT_SNAPSHOT_MAX);
    const previous = await this.admin.adminTodayVisit.findUnique({ where: { superAdminId } });
    const snoozedKeys = new Set(today.snoozes.map((s) => `${s.kind}:${s.ref}`));
    const summary = adminTodayVisitSummary(
      previous
        ? {
            seenAt: previous.seenAt,
            items: Array.isArray(previous.snapshot)
              ? (previous.snapshot as unknown as AdminTodayVisitSnapshotItem[])
              : [],
          }
        : null,
      items,
      snoozedKeys,
      now,
    );
    const snapshot = items as unknown as Prisma.InputJsonValue;
    await this.admin.adminTodayVisit.upsert({
      where: { superAdminId },
      create: { superAdminId, seenAt: now, snapshot },
      update: { seenAt: now, snapshot },
    });
    return summary;
  }

  /**
   * Dinero en juego hoy, sobre lo que sale en la bandeja: deuda vencida, cuota
   * de las pruebas que terminan en 3 días, extras por cobrar y cuota de los
   * clientes que han dejado de entrar.
   */
  private moneyAtRisk(
    lists: Pick<AdminTodayDto, 'pastDue' | 'trialsExpiring' | 'addonCharges' | 'inactivePaying'>,
    now: Date,
  ): AdminTodayMoneyAtRiskDto {
    const round = (n: number) => Math.round(n * 100) / 100;
    const sum = <T>(items: T[], value: (item: T) => number) =>
      round(items.reduce((total, item) => total + value(item), 0));
    const pastDue = sum(lists.pastDue, (t) => t.owedAmount ?? 0);
    const trialsEnding = sum(
      lists.trialsExpiring.filter(
        (t) => (trialEnd(t) - now.getTime()) / MS_PER_DAY <= TRIAL_AT_RISK_DAYS,
      ),
      (t) => t.monthly ?? 0,
    );
    const addonCharges = sum(lists.addonCharges, (c) => c.amount);
    const inactive = sum(lists.inactivePaying, (t) => t.monthly);
    return {
      total: round(pastDue + trialsEnding + addonCharges + inactive),
      pastDue,
      trialsEnding,
      addonCharges,
      inactive,
    };
  }

  /** Plazo de respuesta por prioridad, en horas (el mismo que ve el tenant). */
  private async responseTargets(now: Date): Promise<ResponseTargets> {
    const times = await this.agility.responseTimes(now);
    return {
      urgent: times.byPriority.urgent.hours,
      high: times.byPriority.high.hours,
      normal: times.byPriority.normal.hours,
      low: times.byPriority.low.hours,
    };
  }

  /**
   * Tickets de soporte esperando respuesta del admin (status open), con su
   * plazo de respuesta. Lo que vence antes (o lleva más fuera de plazo), primero.
   */
  private async openTickets(
    now: Date,
    targets: ResponseTargets = DEFAULT_SUPPORT_RESPONSE_HOURS,
  ): Promise<AdminOpenTicketDto[]> {
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
        const targetHours = targets[r.priority] ?? DEFAULT_SUPPORT_RESPONSE_HOURS[r.priority];
        const dueAt = new Date(since.getTime() + targetHours * 3_600_000);
        return {
          since,
          dueAt,
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
            responseTargetHours: Math.round(targetHours * 10) / 10,
            dueAt: dueAt.toISOString(),
            dueInHours: Math.round(((dueAt.getTime() - now.getTime()) / 3_600_000) * 10) / 10,
          },
        };
      })
      .sort((a, b) => {
        const pa = PRIORITY_ORDER[a.dto.priority] ?? 0;
        const pb = PRIORITY_ORDER[b.dto.priority] ?? 0;
        return a.dueAt.getTime() - b.dueAt.getTime() || pb - pa;
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
   * Trabajos de las colas que han fallado en las últimas 24 h y nadie ha marcado
   * como revisados, del más reciente al más antiguo. Los fallidos se guardan 30
   * días: contarlos todos dejaba el aviso encendido un mes.
   */
  private async recentFailedJobs(now: Date): Promise<AdminTodayFailedJobDto[]> {
    const since = now.getTime() - FAILED_JOBS_WINDOW_MS;
    const perQueue = await Promise.all(
      this.queues.map(async (q) => {
        const jobs = await q.getFailed(0, FAILED_JOBS_SCAN - 1);
        return jobs
          .filter((job) => jobFailedAt(job) >= since)
          .map((job) => ({
            queue: q.name,
            id: String(job?.id ?? ''),
            name: job?.name ?? '—',
            reason: shortReason(job?.failedReason),
            failedAtMs: jobFailedAt(job),
            attempts: job?.attemptsMade ?? 0,
          }));
      }),
    );
    const all = perQueue.flat();
    if (all.length === 0) return [];
    const reviewed = await this.admin.adminReviewedJob.findMany({
      where: { OR: all.map((j) => ({ queue: j.queue, jobId: j.id })) },
      select: { queue: true, jobId: true, failedAt: true },
    });
    const reviewedAt = new Map(reviewed.map((r) => [`${r.queue}:${r.jobId}`, r.failedAt]));
    return all
      .filter((j) => {
        const at = reviewedAt.get(`${j.queue}:${j.id}`);
        // Revisado ese mismo fallo; si volvió a fallar después, sale.
        return !at || at.getTime() < j.failedAtMs;
      })
      .sort((a, b) => b.failedAtMs - a.failedAtMs)
      .map(({ failedAtMs, ...j }) => ({ ...j, failedAt: new Date(failedAtMs).toISOString() }));
  }

  private queueByName(name: string): Queue {
    const queue = this.queues.find((q) => q.name === name);
    if (!queue) {
      throw new NotFoundException({ code: 'queue_not_found', message: 'Cola no encontrada' });
    }
    return queue;
  }

  /** Un trabajo que sigue fallido, o un error legible. */
  private async failedJob(queueName: string, id: string): Promise<Job> {
    const job = await this.queueByName(queueName).getJob(id);
    if (!job || !(await job.isFailed())) {
      throw new NotFoundException({
        code: 'job_not_found',
        message: 'El trabajo ya no está entre los fallidos',
      });
    }
    return job;
  }

  /** Reintenta trabajos fallidos de las colas (uno o «todos» los de «Hoy»). */
  async retryJobs(
    input: TodayFailedJobsInput,
    actor: TodayActor,
  ): Promise<AdminTodayBatchResultDto> {
    const result: AdminTodayBatchResultDto = { done: 0, failed: [] };
    for (const j of input.jobs) {
      try {
        const job = await this.failedJob(j.queue, j.id);
        await job.retry();
        await this.admin.adminReviewedJob.deleteMany({ where: { queue: j.queue, jobId: j.id } });
        result.done += 1;
      } catch (err) {
        result.failed.push({ ref: `${j.queue}:${j.id}`, label: j.id, message: errorMessage(err) });
      }
    }
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.queue.job_retried',
      targetType: 'queue_jobs',
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      changes: { jobs: input.jobs, done: result.done, failed: result.failed.length },
    });
    this.invalidate();
    return result;
  }

  /**
   * Marca trabajos fallidos como revisados: dejan de contar aunque no se
   * reintenten. Si el mismo trabajo vuelve a fallar después, vuelve a salir.
   */
  async reviewJobs(
    input: TodayFailedJobsInput,
    actor: TodayActor,
  ): Promise<AdminTodayBatchResultDto> {
    const result: AdminTodayBatchResultDto = { done: 0, failed: [] };
    for (const j of input.jobs) {
      try {
        const job = await this.failedJob(j.queue, j.id);
        const failedAt = new Date(jobFailedAt(job));
        await this.admin.adminReviewedJob.upsert({
          where: { queue_jobId: { queue: j.queue, jobId: j.id } },
          create: { queue: j.queue, jobId: j.id, failedAt, reviewedById: actor.superAdminId },
          update: { failedAt, reviewedById: actor.superAdminId, reviewedAt: new Date() },
        });
        result.done += 1;
      } catch (err) {
        result.failed.push({ ref: `${j.queue}:${j.id}`, label: j.id, message: errorMessage(err) });
      }
    }
    // Lo revisado hace más de 30 días ya no está entre los fallidos.
    await this.admin.adminReviewedJob.deleteMany({
      where: { reviewedAt: { lt: new Date(Date.now() - REVIEWED_JOBS_KEEP_DAYS * MS_PER_DAY) } },
    });
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.queue.job_reviewed',
      targetType: 'queue_jobs',
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      changes: { jobs: input.jobs, done: result.done },
    });
    this.invalidate();
    return result;
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
