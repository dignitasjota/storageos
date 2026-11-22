import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ADMIN_HEALTH_SEGMENTS } from '@storageos/shared';

import { TtlCache } from '../../common/cache/ttl-cache';
import { todayInTimezone } from '../../common/format';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import {
  dateMonthIndex,
  isPayingSubscription,
  loadMrrContext,
  madridMonthIndex,
  monthIndexDate,
  monthIndexKey,
  monthIndexLabel,
  mrrFor,
  MRR_SUBSCRIPTION_SELECT,
} from '../../common/saas-metrics';
import { lastTeamActivityByTenant, teamActivityStatsByTenant } from '../../common/team-activity';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { claimAlert } from './alert-state';
import { PlatformHealthSettingsService } from './health-settings.service';
import { scoreHealth, type HealthSignalsInput, type HealthWeights } from './tenant-health-score';

import type { Prisma } from '@storageos/database';
import type {
  AdminHealthHistoryPointDto,
  AdminHealthSegment,
  AdminTenantHealthDto,
  AdminTenantHealthHistoryDto,
  AdminTenantsHealthDto,
} from '@storageos/shared';

const DAY = 86_400_000;

/** Margen tras el fin del periodo facturado antes de darlo por atrasado. */
const BILLING_GRACE_DAYS = 5;

/**
 * Días que puede pasar un contrato sin factura nueva: su ciclo (30 días por
 * mes facturado) más el margen. Mensual = 35 días.
 */
export function billingCycleDays(intervalMonths: number): number {
  return Math.max(1, intervalMonths) * 30 + BILLING_GRACE_DAYS;
}

/**
 * ¿Tiene el contrato la factura de su ciclo? Sí si su última factura cubre un
 * periodo que aún no ha vencido (prepago, primer pago de varios meses, cupón)
 * o si se emitió dentro de su ciclo.
 */
export function contractBillingOnTime(
  c: { intervalMonths: number; lastIssueDate: Date | null; lastPeriodEnd: Date | null },
  now: number,
): boolean {
  if (c.lastPeriodEnd && c.lastPeriodEnd.getTime() >= now - BILLING_GRACE_DAYS * DAY) return true;
  return (
    !!c.lastIssueDate && c.lastIssueDate.getTime() >= now - billingCycleDays(c.intervalMonths) * DAY
  );
}

/** Días que se guarda la foto diaria (un poco más de un año). */
export const HEALTH_DAILY_RETENTION_DAYS = 400;

/** Semanas de la mini gráfica de cada fila. */
const SPARKLINE_WEEKS = 8;

/** Una caída se compara con la foto de hace una semana (o la más reciente antes). */
const DROP_REFERENCE_DAYS = 7;

const TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  billingExempt: true,
  deletedAt: true,
  trialEndsAt: true,
  tags: true,
  salesRepId: true,
  salesRep: { select: { fullName: true } },
  subscription: {
    select: {
      status: true,
      cancelAtPeriodEnd: true,
      plan: { select: { name: true, slug: true } },
    },
  },
} satisfies Prisma.TenantSelect;

/** Caída de un cliente frente a la foto de una semana antes. */
export interface HealthDrop {
  tenantId: string;
  name: string;
  slug: string;
  from: number;
  to: number;
  points: number;
  /** Día de la foto de referencia («AAAA-MM-DD»). */
  referenceDay: string;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Salud de los clientes y activación de las pruebas para el super admin. La
 * consulta solo lee; la foto diaria (para la tendencia) la guarda la tarea
 * `tenant-health.daily-snapshot` del worker.
 */
@Injectable()
export class TenantHealthService {
  private readonly logger = new Logger(TenantHealthService.name);
  private readonly cache = new TtlCache<AdminTenantHealthDto[]>();

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly settings: PlatformHealthSettingsService,
  ) {}

  /** Olvida lo calculado (tras cambiar los pesos). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Todos los tenants vivos (activos y en prueba), de menor a mayor puntuación. */
  all(): Promise<AdminTenantHealthDto[]> {
    return this.cache.get('all', () => this.compute(null));
  }

  /** Los de un grupo, con el recuento de cada grupo (para las pestañas). */
  async list(segment: AdminHealthSegment = 'paying'): Promise<AdminTenantsHealthDto> {
    const [rows, last] = await Promise.all([
      this.all(),
      this.admin.tenantHealthSnapshot.aggregate({ _max: { updatedAt: true } }),
    ]);
    const counts = Object.fromEntries(ADMIN_HEALTH_SEGMENTS.map((s) => [s, 0])) as Record<
      AdminHealthSegment,
      number
    >;
    for (const r of rows) counts[r.segment] += 1;
    const tenants = rows.filter((r) => r.segment === segment);
    const sum = (level: string) =>
      Math.round(tenants.filter((t) => t.level === level).reduce((a, t) => a + t.mrr, 0) * 100) /
      100;
    const atRisk = sum('at_risk');
    const dormant = sum('dormant');
    return {
      segment,
      counts,
      tenants,
      snapshotAt: last._max.updatedAt?.toISOString() ?? null,
      mrrAtRisk: { atRisk, dormant, total: Math.round((atRisk + dormant) * 100) / 100 },
    };
  }

  /** Puntuación de un tenant (404 si no existe). */
  async one(tenantId: string): Promise<AdminTenantHealthDto> {
    const [row] = await this.compute(tenantId);
    if (!row) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    return row;
  }

  /**
   * Guarda la foto del mes en curso (hora de España) de todos los tenants
   * vivos. La llama la tarea diaria; cada día sustituye la del mes.
   */
  async saveSnapshots(now = new Date()): Promise<number> {
    const rows = await this.compute(null, now);
    if (rows.length === 0) return 0;
    const month = monthIndexDate(madridMonthIndex(now));
    const day = todayInTimezone('Europe/Madrid', now);
    const ids = rows.map((r) => r.tenantId);
    await this.admin.$transaction([
      this.admin.tenantHealthSnapshot.deleteMany({ where: { month, tenantId: { in: ids } } }),
      this.admin.tenantHealthSnapshot.createMany({
        data: rows.map((r) => ({ tenantId: r.tenantId, month, score: r.score, level: r.level })),
      }),
      // Foto diaria (historial y aviso de caída), y fuera las de hace más de un año.
      this.admin.tenantHealthDaily.deleteMany({ where: { day, tenantId: { in: ids } } }),
      this.admin.tenantHealthDaily.createMany({
        data: rows.map((r) => ({
          tenantId: r.tenantId,
          day,
          score: r.score,
          level: r.level,
          segment: r.segment,
        })),
      }),
      this.admin.tenantHealthDaily.deleteMany({
        where: { day: { lt: new Date(day.getTime() - HEALTH_DAILY_RETENTION_DAYS * DAY) } },
      }),
    ]);
    this.cache.clear();
    await this.notifyDrops(now).catch((err: unknown) =>
      this.logger.warn(`[salud] avisos de caída: ${err instanceof Error ? err.message : err}`),
    );
    return rows.length;
  }

  /**
   * Clientes (no pruebas) cuya foto de hoy está `dropAlertPoints` puntos o más
   * por debajo de la de hace una semana (o la más reciente anterior a esa).
   */
  async drops(now = new Date()): Promise<HealthDrop[]> {
    const { dropAlertPoints } = await this.settings.get();
    const day = todayInTimezone('Europe/Madrid', now);
    const ref = new Date(day.getTime() - DROP_REFERENCE_DAYS * DAY);
    const [today, previous] = await Promise.all([
      this.admin.tenantHealthDaily.findMany({
        where: { day, segment: { not: 'trial' } },
        select: { tenantId: true, score: true },
      }),
      this.admin.tenantHealthDaily.findMany({
        where: { day: { lte: ref, gte: new Date(ref.getTime() - 30 * DAY) } },
        orderBy: [{ tenantId: 'asc' }, { day: 'desc' }],
        distinct: ['tenantId'],
        select: { tenantId: true, score: true, day: true },
      }),
    ]);
    const prevBy = new Map(previous.map((p) => [p.tenantId, p]));
    const falling = today
      .map((t) => ({ t, p: prevBy.get(t.tenantId) }))
      .filter(({ t, p }) => p && p.score - t.score >= dropAlertPoints);
    if (falling.length === 0) return [];
    const names = await this.admin.tenant.findMany({
      where: { id: { in: falling.map((f) => f.t.tenantId) }, deletedAt: null },
      select: { id: true, name: true, slug: true },
    });
    const nameBy = new Map(names.map((n) => [n.id, n]));
    return falling
      .filter(({ t }) => nameBy.has(t.tenantId))
      .map(({ t, p }) => ({
        tenantId: t.tenantId,
        name: nameBy.get(t.tenantId)!.name,
        slug: nameBy.get(t.tenantId)!.slug,
        from: p!.score,
        to: t.score,
        points: p!.score - t.score,
        referenceDay: dayKey(p!.day),
      }))
      .sort((a, b) => b.points - a.points);
  }

  /**
   * Aviso al super admin de cada caída (una sola vez por caída: no se repite
   * para ese tenant en 7 días).
   */
  async notifyDrops(now = new Date()): Promise<number> {
    const drops = await this.drops(now);
    let sent = 0;
    for (const d of drops) {
      if (!(await claimAlert(this.admin, 'health_drop', d.tenantId, DROP_REFERENCE_DAYS * 1440))) {
        continue;
      }
      await this.admin.superAdminNotification.create({
        data: {
          type: 'health.drop',
          title: `La salud de ${d.name} ha caído ${d.points} puntos`,
          body: `De ${d.from} a ${d.to} sobre 100 en una semana (${d.slug}).`,
          link: `/admin/tenants/${d.tenantId}?tab=business`,
        },
      });
      sent += 1;
    }
    return sent;
  }

  /** Evolución de un tenant: una foto por mes (12) y una por día (90 días). */
  async history(tenantId: string, now = new Date()): Promise<AdminTenantHealthHistoryDto> {
    const exists = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const nowIdx = madridMonthIndex(now);
    const day = todayInTimezone('Europe/Madrid', now);
    const [monthly, daily] = await Promise.all([
      this.admin.tenantHealthSnapshot.findMany({
        where: { tenantId, month: { gte: monthIndexDate(nowIdx - 11) } },
        orderBy: { month: 'asc' },
        select: { month: true, score: true, level: true },
      }),
      this.admin.tenantHealthDaily.findMany({
        where: { tenantId, day: { gte: new Date(day.getTime() - 89 * DAY) } },
        orderBy: { day: 'asc' },
        select: { day: true, score: true, level: true },
      }),
    ]);
    const monthlyPoints: AdminHealthHistoryPointDto[] = monthly.map((m) => {
      const idx = dateMonthIndex(m.month);
      return {
        date: monthIndexKey(idx),
        label: monthIndexLabel(idx),
        score: m.score,
        level: m.level,
      };
    });
    const dailyPoints: AdminHealthHistoryPointDto[] = daily.map((d) => ({
      date: dayKey(d.day),
      label: d.day.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      score: d.score,
      level: d.level,
    }));
    let biggestDrop: AdminTenantHealthHistoryDto['biggestDrop'] = null;
    for (const d of daily) {
      const ref = [...daily]
        .reverse()
        .find((p) => p.day.getTime() <= d.day.getTime() - DROP_REFERENCE_DAYS * DAY);
      if (!ref) continue;
      const pts = ref.score - d.score;
      if (pts > 0 && (!biggestDrop || pts > biggestDrop.points)) {
        biggestDrop = { date: dayKey(d.day), points: pts };
      }
    }
    return { tenantId, monthly: monthlyPoints, daily: dailyPoints, biggestDrop };
  }

  private async compute(tenantId: string | null, at = new Date()): Promise<AdminTenantHealthDto[]> {
    const tenants = await this.admin.tenant.findMany({
      where: tenantId ? { id: tenantId } : { deletedAt: null, status: { in: ['active', 'trial'] } },
      select: TENANT_SELECT,
    });
    if (tenants.length === 0) return [];
    const [signals, settings] = await Promise.all([
      this.signals(
        tenantId,
        at,
        tenants.map((t) => t.id),
      ),
      this.settings.get(),
    ]);
    const now = at.getTime();
    const weights: HealthWeights = { client: settings.clientWeights, trial: settings.trialWeights };
    const rows = tenants.map((t) => scoreHealth(this.input(t, signals, at), now, weights));
    rows.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return rows;
  }

  private input(
    t: Prisma.TenantGetPayload<{ select: typeof TENANT_SELECT }>,
    s: Awaited<ReturnType<TenantHealthService['signals']>>,
    at: Date,
  ): HealthSignalsInput {
    const billing = s.billing.get(t.id) ?? { expected: 0, onTime: 0 };
    const money = s.money.get(t.id);
    const activity = s.activity.get(t.id);
    return {
      planSlug: t.subscription?.plan?.slug ?? null,
      tags: t.tags,
      salesRepId: t.salesRepId,
      salesRepName: t.salesRep?.fullName ?? null,
      mrr: money?.paying ? money.mrr : 0,
      wouldPay: t.status === 'trial' && money && money.mrr > 0 ? money.mrr : null,
      activeDays30: activity?.activeDays ?? null,
      activeUsers30: activity?.activeUsers ?? null,
      activityTracked: !!activity && activity.firstDay.getTime() <= at.getTime() - 29 * DAY,
      totalUsers: s.users.get(t.id) ?? 0,
      sparkline: s.sparkline.get(t.id) ?? [],
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      billingExempt: t.billingExempt,
      planName: t.subscription?.plan?.name ?? null,
      subStatus: t.subscription?.status ?? null,
      cancelAtPeriodEnd: t.subscription?.cancelAtPeriodEnd ?? false,
      trialEndsAt: t.trialEndsAt,
      paying: !!money?.paying,
      lastActivityAt: s.lastActivity.get(t.id) ?? null,
      billingExpected: billing.expected,
      billingOnTime: billing.onTime,
      activeContracts: s.contracts.get(t.id) ?? 0,
      facilities: s.facilities.get(t.id) ?? 0,
      units: s.units.get(t.id) ?? 0,
      customers: s.customers.get(t.id) ?? 0,
      customersTotal: s.customersTotal.get(t.id) ?? 0,
      portalUsers: s.portalUsers.get(t.id) ?? 0,
      portalEverUsed: s.portalEver.get(t.id) ?? 0,
      staleTickets: s.staleTickets.get(t.id) ?? 0,
      signedContracts: s.signed.get(t.id) ?? 0,
      issuedInvoices: s.invoices.get(t.id) ?? 0,
      previousScore: s.prevScore.get(t.id) ?? null,
    };
  }

  /** Señales por tenant (de todos los vivos o de uno). */
  private async signals(tenantId: string | null, at: Date, ids: string[]) {
    const now = at.getTime();
    const since90d = new Date(now - 90 * DAY);
    const ticketStale = new Date(now - 48 * 60 * 60 * 1000);
    const prevMonth = monthIndexDate(madridMonthIndex(at) - 1);
    const scope: { tenantId?: string } = tenantId ? { tenantId } : {};
    const realCustomer: Prisma.CustomerWhereInput = { ...scope, deletedAt: null, isTest: false };
    const liveCustomer: Prisma.CustomerWhereInput = {
      ...realCustomer,
      contracts: { some: { status: { in: ['active', 'ending'] }, deletedAt: null } },
    };
    const liveContract: Prisma.ContractWhereInput = {
      ...scope,
      deletedAt: null,
      status: { in: ['active', 'ending'] },
      customer: { isTest: false },
    };
    const [
      lastActivity,
      money,
      contracts,
      facilities,
      units,
      tickets,
      customers,
      customersTotal,
      portalUsers,
      portalEver,
      signed,
      invoices,
      billable,
      contractInvoices,
      prevSnapshots,
    ] = await Promise.all([
      lastTeamActivityByTenant(this.admin, tenantId ? [tenantId] : undefined),
      this.moneyByTenant(ids),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: liveContract,
        _count: { _all: true },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.unit.groupBy({ by: ['tenantId'], where: scope, _count: { _all: true } }),
      this.admin.supportTicket.groupBy({
        by: ['tenantId'],
        where: { ...scope, status: 'open', firstResponseAt: null, createdAt: { lt: ticketStale } },
        _count: { _all: true },
      }),
      this.admin.customer.groupBy({
        by: ['tenantId'],
        where: liveCustomer,
        _count: { _all: true },
      }),
      this.admin.customer.groupBy({
        by: ['tenantId'],
        where: realCustomer,
        _count: { _all: true },
      }),
      this.admin.customer.groupBy({
        by: ['tenantId'],
        where: { ...liveCustomer, portalLastSeenAt: { gte: since90d } },
        _count: { _all: true },
      }),
      this.admin.customer.groupBy({
        by: ['tenantId'],
        where: {
          ...realCustomer,
          OR: [{ portalAccessEnabled: true }, { portalLastSeenAt: { not: null } }],
        },
        _count: { _all: true },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null, signedAt: { not: null }, customer: { isTest: false } },
        _count: { _all: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: {
          ...scope,
          deletedAt: null,
          kind: 'invoice',
          status: { notIn: ['draft', 'cancelled'] },
        },
        _count: { _all: true },
      }),
      // Contratos que ya deberían tener la factura de su ciclo: en marcha
      // (sin reservas por abrir) y con un ciclo completo desde que factura.
      this.admin.contract.findMany({
        where: { ...liveContract, ...STARTED_CONTRACT_WHERE },
        select: {
          id: true,
          tenantId: true,
          startDate: true,
          billingStartsOn: true,
          billingIntervalMonths: true,
        },
      }),
      this.admin.invoice.groupBy({
        by: ['contractId'],
        where: {
          ...scope,
          contractId: { not: null },
          deletedAt: null,
          kind: 'invoice',
          status: { notIn: ['draft', 'cancelled'] },
        },
        _max: { issueDate: true, periodEnd: true },
      }),
      this.admin.tenantHealthSnapshot.findMany({
        where: { ...scope, month: prevMonth },
        select: { tenantId: true, score: true, month: true },
      }),
    ]);
    const today = todayInTimezone('Europe/Madrid', at);
    const sparkDays = Array.from(
      { length: SPARKLINE_WEEKS },
      (_, i) => new Date(today.getTime() - (SPARKLINE_WEEKS - 1 - i) * 7 * DAY),
    );
    const [activity, users, sparkRows] = await Promise.all([
      teamActivityStatsByTenant(this.admin, tenantId ? [tenantId] : undefined, at),
      this.admin.user.groupBy({
        by: ['tenantId'],
        where: { ...scope, isActive: true },
        _count: { _all: true },
      }),
      this.admin.tenantHealthDaily.findMany({
        where: { ...scope, day: { in: sparkDays } },
        orderBy: { day: 'asc' },
        select: { tenantId: true, score: true },
      }),
    ]);
    const sparkline = new Map<string, number[]>();
    for (const r of sparkRows) {
      const list = sparkline.get(r.tenantId) ?? [];
      list.push(r.score);
      sparkline.set(r.tenantId, list);
    }
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const lastInvoice = new Map(contractInvoices.map((r) => [r.contractId ?? '', r._max] as const));
    const billing = new Map<string, { expected: number; onTime: number }>();
    for (const c of billable) {
      const anchor = c.billingStartsOn ?? c.startDate;
      const cycle = billingCycleDays(c.billingIntervalMonths);
      if (anchor.getTime() > now - cycle * DAY) continue;
      const inv = lastInvoice.get(c.id);
      const b = billing.get(c.tenantId) ?? { expected: 0, onTime: 0 };
      b.expected += 1;
      if (
        contractBillingOnTime(
          {
            intervalMonths: c.billingIntervalMonths,
            lastIssueDate: inv?.issueDate ?? null,
            lastPeriodEnd: inv?.periodEnd ?? null,
          },
          now,
        )
      ) {
        b.onTime += 1;
      }
      billing.set(c.tenantId, b);
    }
    return {
      lastActivity,
      money,
      activity,
      users: count(users),
      sparkline,
      billing,
      contracts: count(contracts),
      facilities: count(facilities),
      units: count(units),
      staleTickets: count(tickets),
      customers: count(customers),
      customersTotal: count(customersTotal),
      portalUsers: count(portalUsers),
      portalEver: count(portalEver),
      signed: count(signed),
      invoices: count(invoices),
      prevScore: new Map(
        prevSnapshots
          .filter((r) => dateMonthIndex(r.month) === dateMonthIndex(prevMonth))
          .map((r) => [r.tenantId, r.score]),
      ),
    };
  }

  /**
   * Lo que aporta cada tenant al mes sin IVA y si paga de verdad (suscripción
   * que suma al MRR con cuota > 0). En prueba, `mrr` es lo que pagaría.
   */
  private async moneyByTenant(
    ids: string[],
  ): Promise<Map<string, { paying: boolean; mrr: number }>> {
    if (ids.length === 0) return new Map();
    const subs = await this.admin.tenantSubscription.findMany({
      where: { tenantId: { in: ids } },
      select: {
        ...MRR_SUBSCRIPTION_SELECT,
        tenant: { select: { status: true, billingExempt: true, deletedAt: true } },
      },
    });
    const ctx = await loadMrrContext(this.admin, ids);
    const out = new Map<string, { paying: boolean; mrr: number }>();
    for (const s of subs) {
      const mrr = mrrFor(ctx, s.tenantId, s).total;
      out.set(s.tenantId, { paying: isPayingSubscription(s, s.tenant) && mrr > 0, mrr });
    }
    return out;
  }
}
