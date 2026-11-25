import { Injectable } from '@nestjs/common';
import {
  ADMIN_TRIALS_PAGE_SIZE,
  platformLeadName,
  trialConversion,
  trialProgress,
  type AdminExpiredTrialDto,
  type AdminTrialDto,
  type AdminTrialFilter,
  type AdminTrialRowDto,
  type AdminTrialsPageDto,
  type AdminTrialsSummaryDto,
} from '@storageos/shared';

import { currentMonth } from '../../common/format';
import { COLLECTED_PAYMENT_STATUSES } from '../../common/saas-metrics';
import { lastTeamActivityByTenant } from '../../common/team-activity';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminBusinessService } from './admin-business.service';
import { AdminTenantsService } from './admin-tenants.service';

const DAY = 86_400_000;

export interface TrialsQuery {
  search?: string | undefined;
  filter?: AdminTrialFilter | undefined;
  salesRepId?: string | undefined;
  page?: number | undefined;
}

/** Lo que sabemos de cada tenant para la puesta en marcha y el uso real. */
interface TenantExtras {
  progress: Record<
    'facility' | 'units' | 'customers' | 'contract' | 'company' | 'payment',
    boolean
  >;
  invoices: number;
  signedContracts: number;
  salesRepId: string | null;
  salesRepName: string | null;
  leadId: string | null;
  leadName: string | null;
}

/**
 * Trials del panel admin con búsqueda, filtros, páginas, lo que le falta a
 * cada uno para ponerse en marcha y su probabilidad de pagar; las cifras de
 * arriba y las pruebas que terminaron sin pagar.
 */
@Injectable()
export class AdminTrialsOpsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly business: AdminBusinessService,
  ) {}

  /** Puesta en marcha, uso real, comercial y lead de cada tenant (en bloque). */
  async extras(ids: string[]): Promise<Map<string, TenantExtras>> {
    if (ids.length === 0) return new Map();
    const scope = { tenantId: { in: ids } };
    const group = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const [
      tenants,
      facilities,
      units,
      customers,
      contracts,
      invoices,
      redsys,
      gocardless,
      sepa,
      stripe,
      leads,
    ] = await Promise.all([
      this.admin.tenant.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          taxId: true,
          billingLegalName: true,
          billingAddress: true,
          transferIban: true,
          offlineCashEnabled: true,
          offlineTransferEnabled: true,
          offlineSepaEnabled: true,
          salesRepId: true,
          salesRep: { select: { fullName: true } },
        },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.unit.groupBy({
        by: ['tenantId'],
        where: { ...scope, facility: { deletedAt: null } },
        _count: { _all: true },
      }),
      this.admin.customer.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null, isTest: false },
        _count: { _all: true },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null, signedAt: { not: null } },
        _count: { _all: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null, kind: 'invoice', status: { not: 'draft' } },
        _count: { _all: true },
      }),
      this.admin.redsysSettings.findMany({
        where: { ...scope, enabled: true },
        select: { tenantId: true },
      }),
      this.admin.goCardlessSettings.findMany({
        where: { ...scope, enabled: true },
        select: { tenantId: true },
      }),
      this.admin.sepaSettings.findMany({
        where: { ...scope, enabled: true },
        select: { tenantId: true },
      }),
      this.admin.tenantStripeAccount.findMany({
        where: { ...scope, chargesEnabled: true },
        select: { tenantId: true },
      }),
      this.admin.platformLead.findMany({
        where: { tenantId: { in: ids } },
        select: { id: true, tenantId: true, companyName: true, contactName: true, email: true },
      }),
    ]);
    const facBy = group(facilities);
    const unitBy = group(units);
    const custBy = group(customers);
    const contBy = group(contracts);
    const invBy = group(invoices);
    const payers = new Set([...redsys, ...gocardless, ...sepa, ...stripe].map((r) => r.tenantId));
    const leadBy = new Map(leads.map((l) => [l.tenantId, l]));
    const out = new Map<string, TenantExtras>();
    for (const t of tenants) {
      const lead = leadBy.get(t.id);
      out.set(t.id, {
        progress: {
          facility: (facBy.get(t.id) ?? 0) > 0,
          units: (unitBy.get(t.id) ?? 0) > 0,
          customers: (custBy.get(t.id) ?? 0) > 0,
          contract: (contBy.get(t.id) ?? 0) > 0,
          company: !!(t.taxId && t.billingLegalName && t.billingAddress),
          payment:
            payers.has(t.id) ||
            !!t.transferIban ||
            t.offlineCashEnabled ||
            t.offlineTransferEnabled ||
            t.offlineSepaEnabled,
        },
        invoices: invBy.get(t.id) ?? 0,
        signedContracts: contBy.get(t.id) ?? 0,
        salesRepId: t.salesRepId,
        salesRepName: t.salesRep?.fullName ?? null,
        leadId: lead?.id ?? null,
        leadName: lead ? platformLeadName(lead) : null,
      });
    }
    return out;
  }

  private matches(t: AdminTrialRowDto, filter: AdminTrialFilter, now: Date): boolean {
    const ends = t.trialEndsAt ? new Date(t.trialEndsAt).getTime() : null;
    switch (filter) {
      case 'this_week':
        return ends !== null && ends >= now.getTime() && ends <= now.getTime() + 7 * DAY;
      case 'expired':
        return ends !== null && ends < now.getTime();
      case 'unused':
        return t.neverUsed;
      case 'real_use':
        return t.activeContracts > 0 || t.invoices > 0;
      default:
        return true;
    }
  }

  async page(query: TrialsQuery, now = new Date()): Promise<AdminTrialsPageDto> {
    const trials: AdminTrialDto[] = await this.tenants.listTrials();
    const extras = await this.extras(trials.map((t) => t.id));
    const search = query.search?.trim().toLowerCase();
    const rows: AdminTrialRowDto[] = trials
      .map((t) => {
        const x = extras.get(t.id);
        const progress = trialProgress(
          x?.progress ?? {
            facility: false,
            units: false,
            customers: false,
            contract: false,
            company: false,
            payment: false,
          },
        );
        return {
          ...t,
          progress,
          conversion: trialConversion({
            progressDone: progress.done,
            progressTotal: progress.total,
            activeContracts: Math.max(t.activeContracts, x?.signedContracts ?? 0),
            invoices: x?.invoices ?? 0,
            lastActivityAt: t.lastActivityAt ? new Date(t.lastActivityAt) : null,
            now,
          }),
          invoices: x?.invoices ?? 0,
          salesRepId: x?.salesRepId ?? null,
          salesRepName: x?.salesRepName ?? null,
          leadId: x?.leadId ?? null,
          leadName: x?.leadName ?? null,
        };
      })
      .filter(
        (t) =>
          (!search ||
            t.name.toLowerCase().includes(search) ||
            t.slug.toLowerCase().includes(search) ||
            (t.leadName ?? '').toLowerCase().includes(search)) &&
          (!query.salesRepId || t.salesRepId === query.salesRepId),
      );
    const filters: AdminTrialFilter[] = ['all', 'this_week', 'expired', 'unused', 'real_use'];
    const counts = Object.fromEntries(
      filters.map((f) => [f, rows.filter((t) => this.matches(t, f, now)).length]),
    ) as Record<AdminTrialFilter, number>;
    const filtered = rows.filter((t) => this.matches(t, query.filter ?? 'all', now));
    const pageSize = ADMIN_TRIALS_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, Math.trunc(query.page ?? 1) || 1), pages);
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      counts,
      summary: await this.summary(trials.length, now),
    };
  }

  async summary(inProgress: number, now = new Date()): Promise<AdminTrialsSummaryDto> {
    const { start } = currentMonth(now);
    const [ended, extended, funnel] = await Promise.all([
      this.admin.tenant.findMany({
        where: { billingExempt: false, trialEndedAt: { gte: start } },
        select: { id: true },
      }),
      this.admin.superAdminAuditLog.findMany({
        where: { action: 'admin.tenant.trial_extended', occurredAt: { gte: start } },
        select: { targetTenantId: true },
        distinct: ['targetTenantId'],
      }),
      this.business.trialFunnel(3).catch(() => null),
    ]);
    const ids = ended.map((t) => t.id);
    const paid = ids.length
      ? await this.admin.tenantSubscriptionPayment.groupBy({
          by: ['tenantId'],
          where: {
            tenantId: { in: ids },
            status: { in: [...COLLECTED_PAYMENT_STATUSES] },
            paidAt: { not: null },
          },
        })
      : [];
    return {
      inProgress,
      endedThisMonth: ids.length,
      convertedThisMonth: paid.length,
      conversionMonthPct: ids.length ? Math.round((paid.length / ids.length) * 100) : null,
      avgDaysToPay: funnel?.avgDaysToPay ?? null,
      extendedThisMonth: extended.length,
    };
  }

  /**
   * Pruebas que terminaron sin pagar: siguen activas pero en solo lectura
   * (suscripción caducada). Las más recientes primero.
   */
  async expired(now = new Date()): Promise<AdminExpiredTrialDto[]> {
    const rows = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: 'active',
        subscription: { status: 'expired' },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        trialEndsAt: true,
        trialEndedAt: true,
        subscription: { select: { plan: { select: { name: true, slug: true } } } },
      },
      take: 500,
    });
    const ids = rows.map((t) => t.id);
    if (ids.length === 0) return [];
    const scope = { tenantId: { in: ids } };
    const group = (r: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(r.map((x) => [x.tenantId, x._count._all]));
    const [extras, login, facilities, units, contracts] = await Promise.all([
      this.extras(ids),
      lastTeamActivityByTenant(this.admin, ids),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.unit.groupBy({
        by: ['tenantId'],
        where: { ...scope, facility: { deletedAt: null } },
        _count: { _all: true },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null, status: { in: ['active', 'ending'] } },
        _count: { _all: true },
      }),
    ]);
    const facBy = group(facilities);
    const unitBy = group(units);
    const contBy = group(contracts);
    return rows
      .map((t) => {
        const ended = t.trialEndedAt ?? t.trialEndsAt;
        const x = extras.get(t.id);
        return {
          id: t.id,
          name: t.name,
          slug: t.slug,
          planName: t.subscription?.plan.name ?? null,
          planSlug: t.subscription?.plan.slug ?? null,
          endedAt: ended?.toISOString() ?? null,
          daysSince: ended
            ? Math.max(0, Math.floor((now.getTime() - ended.getTime()) / DAY))
            : null,
          lastActivityAt: login.get(t.id)?.toISOString() ?? null,
          facilities: facBy.get(t.id) ?? 0,
          units: unitBy.get(t.id) ?? 0,
          activeContracts: contBy.get(t.id) ?? 0,
          salesRepName: x?.salesRepName ?? null,
          leadId: x?.leadId ?? null,
        };
      })
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  }
}
