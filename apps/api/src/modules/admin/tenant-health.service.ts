import { Injectable, NotFoundException } from '@nestjs/common';
import { ADMIN_HEALTH_SEGMENTS } from '@storageos/shared';

import { TtlCache } from '../../common/cache/ttl-cache';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import {
  dateMonthIndex,
  loadMrrContext,
  madridMonthIndex,
  monthIndexDate,
  mrrFor,
  MRR_SUBSCRIPTION_SELECT,
  PAYING_SUBSCRIPTION_WHERE,
} from '../../common/saas-metrics';
import { lastTeamActivityByTenant } from '../../common/team-activity';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { scoreHealth, type HealthSignalsInput } from './tenant-health-score';

import type { Prisma } from '@storageos/database';
import type {
  AdminHealthSegment,
  AdminTenantHealthDto,
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

const TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  billingExempt: true,
  trialEndsAt: true,
  subscription: {
    select: { status: true, cancelAtPeriodEnd: true, plan: { select: { name: true } } },
  },
} satisfies Prisma.TenantSelect;

/**
 * Salud de los clientes y activación de las pruebas para el super admin. La
 * consulta solo lee; la foto diaria (para la tendencia) la guarda la tarea
 * `tenant-health.daily-snapshot` del worker.
 */
@Injectable()
export class TenantHealthService {
  private readonly cache = new TtlCache<AdminTenantHealthDto[]>();

  constructor(private readonly admin: PrismaAdminService) {}

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
    return {
      segment,
      counts,
      tenants: rows.filter((r) => r.segment === segment),
      snapshotAt: last._max.updatedAt?.toISOString() ?? null,
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
    await this.admin.$transaction([
      this.admin.tenantHealthSnapshot.deleteMany({
        where: { month, tenantId: { in: rows.map((r) => r.tenantId) } },
      }),
      this.admin.tenantHealthSnapshot.createMany({
        data: rows.map((r) => ({ tenantId: r.tenantId, month, score: r.score, level: r.level })),
      }),
    ]);
    this.cache.clear();
    return rows.length;
  }

  private async compute(tenantId: string | null, at = new Date()): Promise<AdminTenantHealthDto[]> {
    const tenants = await this.admin.tenant.findMany({
      where: tenantId ? { id: tenantId } : { deletedAt: null, status: { in: ['active', 'trial'] } },
      select: TENANT_SELECT,
    });
    if (tenants.length === 0) return [];
    const signals = await this.signals(tenantId, at);
    const now = at.getTime();
    const rows = tenants.map((t) => scoreHealth(this.input(t, signals), now));
    rows.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return rows;
  }

  private input(
    t: Prisma.TenantGetPayload<{ select: typeof TENANT_SELECT }>,
    s: Awaited<ReturnType<TenantHealthService['signals']>>,
  ): HealthSignalsInput {
    const billing = s.billing.get(t.id) ?? { expected: 0, onTime: 0 };
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      billingExempt: t.billingExempt,
      planName: t.subscription?.plan?.name ?? null,
      subStatus: t.subscription?.status ?? null,
      cancelAtPeriodEnd: t.subscription?.cancelAtPeriodEnd ?? false,
      trialEndsAt: t.trialEndsAt,
      paying: s.paying.has(t.id),
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
  private async signals(tenantId: string | null, at: Date) {
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
      paying,
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
      this.payingIds(tenantId),
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
      paying,
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

  /** Tenants cuya suscripción suma al MRR con cuota > 0 (los que pagan). */
  private async payingIds(tenantId: string | null): Promise<Set<string>> {
    const subs = await this.admin.tenantSubscription.findMany({
      where: { ...PAYING_SUBSCRIPTION_WHERE, ...(tenantId ? { tenantId } : {}) },
      select: MRR_SUBSCRIPTION_SELECT,
    });
    if (subs.length === 0) return new Set();
    const ctx = await loadMrrContext(
      this.admin,
      subs.map((s) => s.tenantId),
    );
    return new Set(subs.filter((s) => mrrFor(ctx, s.tenantId, s).total > 0).map((s) => s.tenantId));
  }
}
