import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';
import {
  FEATURE_LABELS,
  TenantFeatures,
  effectiveFeaturesFromList,
  resolvePlanFeatures,
} from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type { InvoiceStatus } from '@storageos/database';
import type {
  AdminAdoptionDto,
  AdminAtRiskDto,
  AdminCustomDomainDto,
  AdminAtRiskTenantDto,
  AdminFeatureAdoptionDto,
  AdminOnboardingDto,
  AdminTenantAdoptionDto,
  AdminTenantCustomerDto,
  AdminTenantDto,
  AdminTenantFacilityDto,
  AdminTenantFeaturesDto,
  AdminChangePlanPreviewDto,
  AdminTenantHealthDto,
  AdminTenantHealthFactorDto,
  AdminTenantHealthLevel,
  AdminTenantInvoicingDto,
  AdminTenantUnitDto,
  AdminTenantUserDto,
  TenantFeature,
} from '@storageos/shared';

/** Estados de factura que cuentan como facturación (excluye draft/cancelled). */
const ACCOUNTING_STATUSES: InvoiceStatus[] = [
  'issued',
  'paid',
  'overdue',
  'refunded',
  'partially_refunded',
];

const MONTHS_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface ActionMeta {
  superAdminId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface ExtendTrialArgs extends ActionMeta {
  days: number;
}

/** Resumen de lo anonimizado, devuelto al super admin. */
export interface AnonymizeTenantResult {
  tenantId: string;
  anonymizedCustomers: number;
  anonymizedUsers: number;
}

/** Placeholder con el que se sustituye cada campo de texto personal. */
const ANON = '*** ANONIMIZADO ***';

/**
 * Operaciones de super admin sobre tenants: lectura cross-tenant + acciones
 * de plataforma (suspender, reactivar, extender trial, anonimizar).
 *
 * Usa `PrismaAdminService` (bypass RLS) porque las super admins ven todos
 * los tenants. Cada accion deja rastro en `audit_logs` del tenant afectado.
 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
  ) {}

  // =============================== read ====================================

  async list(filters: { search?: string; status?: string }): Promise<AdminTenantDto[]> {
    const rows = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        ...(filters.status
          ? { status: filters.status as 'trial' | 'active' | 'suspended' | 'cancelled' }
          : {}),
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { slug: { contains: filters.search, mode: 'insensitive' } },
                { billingEmail: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        subscription: { include: { plan: true } },
        _count: {
          select: {
            users: true,
            customers: true,
            contracts: true,
            facilities: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string): Promise<AdminTenantDto> {
    const row = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      include: {
        subscription: { include: { plan: true } },
        _count: {
          select: {
            users: true,
            customers: true,
            contracts: true,
            facilities: { where: { deletedAt: null } },
          },
        },
      },
    });
    if (!row || row.deletedAt) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'Tenant no encontrado',
      });
    }
    return this.toDto(row);
  }

  /**
   * Tenants en riesgo (retención), agrupados por motivo:
   * - trials que expiran en ≤7 días,
   * - suscripciones con pago fallido (`past_due`),
   * - activos sin actividad de usuario en 14+ días (incluye los que nunca
   *   han accedido).
   */
  async getAtRisk(): Promise<AdminAtRiskDto> {
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const inactiveCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const planInclude = { subscription: { include: { plan: { select: { name: true } } } } };

    const [trials, pastDue, activeTenants, lastLogins] = await Promise.all([
      this.admin.tenant.findMany({
        where: { deletedAt: null, status: 'trial', trialEndsAt: { gte: now, lte: in7d } },
        include: planInclude,
        orderBy: { trialEndsAt: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: { deletedAt: null, subscription: { status: 'past_due' } },
        include: planInclude,
        orderBy: { name: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: { deletedAt: null, status: 'active' },
        include: planInclude,
        orderBy: { name: 'asc' },
      }),
      this.admin.user.groupBy({ by: ['tenantId'], _max: { lastLoginAt: true } }),
    ]);

    const lastLoginByTenant = new Map(
      lastLogins.map((l) => [l.tenantId, l._max.lastLoginAt ?? null]),
    );

    const toDto = (
      t: {
        id: string;
        name: string;
        slug: string;
        status: string;
        subscription: { plan: { name: string } | null } | null;
      },
      reason: string,
      since: Date | null,
      detail: string,
    ): AdminAtRiskTenantDto => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      planName: t.subscription?.plan?.name ?? null,
      reason,
      since: since?.toISOString() ?? null,
      detail,
    });

    const trialExpiring = trials.map((t) =>
      toDto(t, 'trial_expiring', t.trialEndsAt, 'El trial expira pronto'),
    );
    const pastDueList = pastDue.map((t) =>
      toDto(t, 'past_due', null, 'Pago de la suscripción fallido'),
    );
    const inactive = activeTenants
      .filter((t) => {
        const last = lastLoginByTenant.get(t.id) ?? null;
        return !last || last < inactiveCutoff;
      })
      .map((t) => {
        const last = lastLoginByTenant.get(t.id) ?? null;
        return toDto(
          t,
          'inactive',
          last,
          last ? 'Sin actividad reciente' : 'Ningún usuario ha accedido nunca',
        );
      });

    return { trialExpiring, pastDue: pastDueList, inactive };
  }

  // --- Health score por tenant -------------------------------------------

  /**
   * Health score 0-100 de cada tenant activo/trial, ordenado de menor (más
   * urgente) a mayor. Combina 4 señales ponderadas: actividad del equipo,
   * facturación reciente, estado de la suscripción y adopción (contratos +
   * locales). Solo lectura/agregación cross-tenant.
   */
  async getTenantsHealth(): Promise<AdminTenantHealthDto[]> {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [tenants, lastLogins, recentInvoices, activeContracts, facilities] = await Promise.all([
      this.admin.tenant.findMany({
        where: { deletedAt: null, status: { in: ['active', 'trial'] } },
        include: { subscription: { include: { plan: { select: { name: true } } } } },
      }),
      this.admin.user.groupBy({ by: ['tenantId'], _max: { lastLoginAt: true } }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: {
          deletedAt: null,
          status: { in: ['issued', 'paid', 'overdue'] },
          issueDate: { gte: since30d },
        },
        _count: { _all: true },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { deletedAt: null, status: { in: ['active', 'ending'] } },
        _count: { _all: true },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const lastLoginBy = new Map(lastLogins.map((l) => [l.tenantId, l._max.lastLoginAt ?? null]));
    const invoicesBy = new Map(recentInvoices.map((r) => [r.tenantId, r._count._all]));
    const contractsBy = new Map(activeContracts.map((c) => [c.tenantId, c._count._all]));
    const facilitiesBy = new Map(facilities.map((f) => [f.tenantId, f._count._all]));

    const result = tenants.map((t) =>
      this.scoreTenant({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        planName: t.subscription?.plan?.name ?? null,
        subStatus: t.subscription?.status ?? null,
        cancelAtPeriodEnd: t.subscription?.cancelAtPeriodEnd ?? false,
        trialEndsAt: t.trialEndsAt,
        lastLoginAt: lastLoginBy.get(t.id) ?? null,
        recentInvoices: invoicesBy.get(t.id) ?? 0,
        activeContracts: contractsBy.get(t.id) ?? 0,
        facilities: facilitiesBy.get(t.id) ?? 0,
      }),
    );
    // Más urgentes primero (menor score).
    result.sort((a, b) => a.score - b.score);
    return result;
  }

  /** Health score de un tenant concreto (404 si no existe). */
  async getTenantHealth(tenantId: string): Promise<AdminTenantHealthDto> {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      include: { subscription: { include: { plan: { select: { name: true } } } } },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const [lastLogin, recentInvoices, activeContracts, facilities] = await Promise.all([
      this.admin.user.aggregate({ where: { tenantId }, _max: { lastLoginAt: true } }),
      this.admin.invoice.count({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ['issued', 'paid', 'overdue'] },
          issueDate: { gte: since30d },
        },
      }),
      this.admin.contract.count({
        where: { tenantId, deletedAt: null, status: { in: ['active', 'ending'] } },
      }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
    ]);
    return this.scoreTenant({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      planName: tenant.subscription?.plan?.name ?? null,
      subStatus: tenant.subscription?.status ?? null,
      cancelAtPeriodEnd: tenant.subscription?.cancelAtPeriodEnd ?? false,
      trialEndsAt: tenant.trialEndsAt,
      lastLoginAt: lastLogin._max.lastLoginAt ?? null,
      recentInvoices,
      activeContracts,
      facilities,
    });
  }

  /** Cálculo puro del score a partir de las señales ya recopiladas. */
  private scoreTenant(s: {
    id: string;
    name: string;
    slug: string;
    status: string;
    planName: string | null;
    subStatus: string | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: Date | null;
    lastLoginAt: Date | null;
    recentInvoices: number;
    activeContracts: number;
    facilities: number;
  }): AdminTenantHealthDto {
    const now = Date.now();
    const daysSince = (d: Date | null): number =>
      d ? (now - d.getTime()) / (24 * 60 * 60 * 1000) : Infinity;

    // 1) Engagement: recencia del último login del equipo.
    const loginDays = daysSince(s.lastLoginAt);
    const engagement =
      loginDays <= 7 ? 100 : loginDays <= 14 ? 80 : loginDays <= 30 ? 50 : loginDays <= 90 ? 20 : 0;
    const engagementDetail = s.lastLoginAt
      ? `Último acceso hace ${Math.floor(loginDays)} d`
      : 'Ningún acceso registrado';

    // 2) Facturación: facturas emitidas en los últimos 30 días.
    const billing =
      s.recentInvoices >= 5 ? 100 : s.recentInvoices >= 2 ? 75 : s.recentInvoices >= 1 ? 50 : 0;
    const billingDetail = `${s.recentInvoices} factura(s) en 30 días`;

    // 3) Suscripción: estado de pago / trial.
    let subscription: number;
    let subDetail: string;
    if (s.subStatus === 'past_due') {
      subscription = 10;
      subDetail = 'Pago de la suscripción fallido';
    } else if (s.cancelAtPeriodEnd) {
      subscription = 20;
      subDetail = 'Cancelación programada';
    } else if (s.status === 'trial') {
      const trialDaysLeft = s.trialEndsAt
        ? (s.trialEndsAt.getTime() - now) / (24 * 60 * 60 * 1000)
        : 0;
      subscription = trialDaysLeft > 7 ? 70 : 40;
      subDetail =
        trialDaysLeft > 0 ? `Trial: ${Math.ceil(trialDaysLeft)} d restantes` : 'Trial vencido';
    } else if (s.subStatus === 'active' || s.status === 'active') {
      subscription = 100;
      subDetail = 'Suscripción activa';
    } else {
      subscription = 50;
      subDetail = s.subStatus ?? s.status;
    }

    // 4) Adopción: contratos activos + locales configurados.
    const adoption =
      s.activeContracts >= 10
        ? 100
        : s.activeContracts >= 3
          ? 70
          : s.activeContracts >= 1
            ? 40
            : s.facilities > 0
              ? 15
              : 0;
    const adoptionDetail = `${s.activeContracts} contrato(s) activo(s) · ${s.facilities} local(es)`;

    const factors: AdminTenantHealthFactorDto[] = [
      {
        key: 'engagement',
        label: 'Actividad del equipo',
        score: engagement,
        weight: 0.35,
        detail: engagementDetail,
      },
      {
        key: 'billing',
        label: 'Facturación reciente',
        score: billing,
        weight: 0.25,
        detail: billingDetail,
      },
      {
        key: 'subscription',
        label: 'Suscripción',
        score: subscription,
        weight: 0.25,
        detail: subDetail,
      },
      { key: 'adoption', label: 'Adopción', score: adoption, weight: 0.15, detail: adoptionDetail },
    ];
    const score = Math.round(factors.reduce((acc, f) => acc + f.score * f.weight, 0));
    const level: AdminTenantHealthLevel =
      score >= 75 ? 'healthy' : score >= 50 ? 'warm' : score >= 25 ? 'at_risk' : 'dormant';

    return {
      tenantId: s.id,
      name: s.name,
      slug: s.slug,
      status: s.status,
      planName: s.planName,
      score,
      level,
      factors,
      lastActivityAt: s.lastLoginAt ? s.lastLoginAt.toISOString() : null,
    };
  }

  // --- Adopción de features + upsell -------------------------------------

  /**
   * Por cada tenant: qué features premium usa de verdad (señal por tabla), uso
   * vs límites del plan, y si es candidato a subir de plan. El **plan
   * recomendado** es el más barato que cubre todas sus features en uso y sus
   * límites; es candidato si ese plan es más caro que el actual (engloba tanto
   * "usa una feature fuera de su plan" como "topa límites"). Solo lectura.
   */
  async getAdoption(): Promise<AdminAdoptionDto> {
    const [
      tenants,
      plans,
      aiRows,
      bankRows,
      rentRows,
      insuranceRows,
      credentialRows,
      deviceRows,
      automationRows,
      sepaRows,
      unitRows,
      facilityRows,
      userRows,
    ] = await Promise.all([
      this.admin.tenant.findMany({
        where: { deletedAt: null, status: { in: ['active', 'trial'] } },
        include: { subscription: { include: { plan: true } } },
      }),
      this.admin.subscriptionPlan.findMany({ where: { isActive: true } }),
      this.admin.aiConversation.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.bankStatement.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.rentIncrease.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.insurancePlan.groupBy({
        by: ['tenantId'],
        where: { isActive: true },
        _count: { _all: true },
      }),
      this.admin.accessCredential.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.accessDevice.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.automationRule.groupBy({
        by: ['tenantId'],
        where: { isActive: true },
        _count: { _all: true },
      }),
      this.admin.sepaSettings.findMany({ where: { enabled: true }, select: { tenantId: true } }),
      this.admin.unit.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.user.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    ]);

    const countMap = (
      rows: { tenantId: string; _count: { _all: number } }[],
    ): Map<string, number> => new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const ai = countMap(aiRows);
    const bank = countMap(bankRows);
    const rent = countMap(rentRows);
    const insurance = countMap(insuranceRows);
    const credentials = countMap(credentialRows);
    const devices = countMap(deviceRows);
    const automations = countMap(automationRows);
    const sepaEnabled = new Set(sepaRows.map((r) => r.tenantId));
    const units = countMap(unitRows);
    const facilities = countMap(facilityRows);
    const users = countMap(userRows);

    /** Features que el tenant USA de verdad (señal por feature). */
    const usedFeaturesOf = (id: string): Set<TenantFeature> => {
      const s = new Set<TenantFeature>();
      if ((ai.get(id) ?? 0) > 0) s.add('ai_assistant');
      if (sepaEnabled.has(id)) s.add('sepa');
      if ((bank.get(id) ?? 0) > 0) s.add('bank_reconciliation');
      if ((rent.get(id) ?? 0) > 0) s.add('rent_increases');
      if ((insurance.get(id) ?? 0) > 0) s.add('insurance');
      if ((credentials.get(id) ?? 0) > 0 || (devices.get(id) ?? 0) > 0) s.add('access_control');
      if ((automations.get(id) ?? 0) > 0) s.add('automations');
      return s;
    };

    // Planes ordenados por precio asc para elegir el más barato que cubra.
    const sortedPlans = [...plans].sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly));
    const planCovers = (
      plan: (typeof plans)[number],
      used: Set<TenantFeature>,
      u: number,
      f: number,
      usr: number,
    ): boolean => {
      const feats = resolvePlanFeatures(plan);
      for (const ft of used) if (!feats.includes(ft)) return false;
      if (plan.maxUnits !== null && u > plan.maxUnits) return false;
      if (plan.maxFacilities !== null && f > plan.maxFacilities) return false;
      if (plan.maxUsers !== null && usr > plan.maxUsers) return false;
      return true;
    };

    const tenantDtos: AdminTenantAdoptionDto[] = tenants.map((t) => {
      const plan = t.subscription?.plan ?? null;
      const planSlug = plan?.slug ?? null;
      const inPlan = plan ? resolvePlanFeatures(plan) : [];
      const used = usedFeaturesOf(t.id);
      const u = units.get(t.id) ?? 0;
      const f = facilities.get(t.id) ?? 0;
      const usr = users.get(t.id) ?? 0;

      const features = TenantFeatures.map((ft) => ({
        feature: ft,
        label: FEATURE_LABELS[ft],
        inPlan: inPlan.includes(ft),
        used: used.has(ft),
      }));
      const usesFeatureOutsidePlan = [...used].some((ft) => !inPlan.includes(ft));
      const tapsLimit =
        (plan?.maxUnits != null && u >= plan.maxUnits) ||
        (plan?.maxFacilities != null && f >= plan.maxFacilities) ||
        (plan?.maxUsers != null && usr >= plan.maxUsers);

      const currentPrice = plan ? Number(plan.priceMonthly) : 0;
      const recommended = sortedPlans.find((p) => planCovers(p, used, u, f, usr)) ?? null;
      const isCandidate = !!recommended && Number(recommended.priceMonthly) > currentPrice;

      return {
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        planSlug,
        planName: plan?.name ?? null,
        features,
        usage: {
          units: u,
          maxUnits: plan?.maxUnits ?? null,
          facilities: f,
          maxFacilities: plan?.maxFacilities ?? null,
          users: usr,
          maxUsers: plan?.maxUsers ?? null,
        },
        usesFeatureOutsidePlan,
        tapsLimit,
        isCandidate,
        recommendedPlanSlug: isCandidate ? (recommended?.slug ?? null) : null,
        recommendedPlanName: isCandidate ? (recommended?.name ?? null) : null,
      };
    });

    // Resumen de adopción por feature.
    const featureAdoption: AdminFeatureAdoptionDto[] = TenantFeatures.map((ft) => ({
      feature: ft,
      label: FEATURE_LABELS[ft],
      tenantsUsing: tenantDtos.filter((t) => t.features.find((x) => x.feature === ft)?.used).length,
      tenantsWithAccess: tenantDtos.filter((t) => t.features.find((x) => x.feature === ft)?.inPlan)
        .length,
    }));

    // Candidatos primero, luego por nombre.
    tenantDtos.sort((a, b) => {
      if (a.isCandidate !== b.isCandidate) return a.isCandidate ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      tenants: tenantDtos,
      featureAdoption,
      candidateCount: tenantDtos.filter((t) => t.isCandidate).length,
    };
  }

  /** Lista los usuarios (staff) de un tenant con datos relevantes para soporte. */
  async listUsers(tenantId: string): Promise<AdminTenantUserDto[]> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const users = await this.admin.user.findMany({
      where: { tenantId },
      include: {
        tenantRole: { select: { name: true } },
        _count: { select: { facilities: true } },
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
    return users.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      role: u.role,
      tenantRoleName: u.tenantRole?.name ?? null,
      isActive: u.isActive,
      emailVerified: u.emailVerifiedAt !== null,
      twoFactorEnabled: u.twoFactorEnabled,
      facilitiesCount: u._count.facilities,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  /**
   * Resumen de la facturación que el tenant emite a sus inquilinos (volumen de
   * su negocio): totales + serie de los últimos 12 meses. Cross-tenant vía
   * `PrismaAdminService`. Misma lógica que `AnalyticsService` (invoices por
   * `issueDate`, pagos `succeeded` por `paidAt`).
   */
  async getInvoicing(tenantId: string): Promise<AdminTenantInvoicingDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true, currency: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }

    // Ventana de 12 meses (UTC), del más antiguo al actual.
    const now = new Date();
    const baseY = now.getUTCFullYear();
    const baseM = now.getUTCMonth();
    const months = Array.from({ length: 12 }, (_, idx) => {
      const d = new Date(Date.UTC(baseY, baseM - (11 - idx), 1));
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      return {
        year,
        month,
        key: `${year}-${String(month).padStart(2, '0')}`,
        label: `${MONTHS_ES[month - 1]} ${String(year % 100).padStart(2, '0')}`,
      };
    });
    const fromDate = new Date(Date.UTC(months[0]!.year, months[0]!.month - 1, 1));
    const toExclusive = new Date(Date.UTC(baseY, baseM + 1, 1));

    const [totals, pending, overdueCount, collected, invoices, payments] = await Promise.all([
      this.admin.invoice.aggregate({
        where: { tenantId, deletedAt: null, status: { in: ACCOUNTING_STATUSES } },
        _sum: { total: true },
        _count: true,
      }),
      this.admin.invoice.aggregate({
        where: { tenantId, deletedAt: null, status: { in: ['issued', 'overdue'] } },
        _sum: { total: true, amountPaid: true, amountRefunded: true },
      }),
      this.admin.invoice.count({ where: { tenantId, deletedAt: null, status: 'overdue' } }),
      this.admin.payment.aggregate({
        where: { tenantId, status: 'succeeded' },
        _sum: { amount: true },
      }),
      this.admin.invoice.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ACCOUNTING_STATUSES },
          issueDate: { gte: fromDate, lt: toExclusive },
        },
        select: { issueDate: true, total: true },
      }),
      this.admin.payment.findMany({
        where: { tenantId, status: 'succeeded', paidAt: { gte: fromDate, lt: toExclusive } },
        select: { paidAt: true, amount: true },
      }),
    ]);

    const invoicedByKey = new Map<string, number>();
    for (const inv of invoices) {
      if (!inv.issueDate) continue;
      const key = `${inv.issueDate.getUTCFullYear()}-${String(inv.issueDate.getUTCMonth() + 1).padStart(2, '0')}`;
      invoicedByKey.set(key, (invoicedByKey.get(key) ?? 0) + Number(inv.total));
    }
    const collectedByKey = new Map<string, number>();
    for (const p of payments) {
      if (!p.paidAt) continue;
      const key = `${p.paidAt.getUTCFullYear()}-${String(p.paidAt.getUTCMonth() + 1).padStart(2, '0')}`;
      collectedByKey.set(key, (collectedByKey.get(key) ?? 0) + Number(p.amount));
    }

    const totalInvoiced = Number(totals._sum.total ?? 0);
    const invoiceCount = totals._count;
    const totalPending =
      Number(pending._sum.total ?? 0) -
      Number(pending._sum.amountPaid ?? 0) -
      Number(pending._sum.amountRefunded ?? 0);

    return {
      currency: tenant.currency,
      totalInvoiced: round2(totalInvoiced),
      totalCollected: round2(Number(collected._sum.amount ?? 0)),
      totalPending: round2(Math.max(0, totalPending)),
      invoiceCount,
      overdueCount,
      avgInvoice: invoiceCount > 0 ? round2(totalInvoiced / invoiceCount) : 0,
      monthly: months.map((m) => ({
        label: m.label,
        invoiced: round2(invoicedByKey.get(m.key) ?? 0),
        collected: round2(collectedByKey.get(m.key) ?? 0),
      })),
    };
  }

  /** Inquilinos (customers) del tenant con nº de contratos (total y vigentes). */
  async listCustomers(tenantId: string): Promise<AdminTenantCustomerDto[]> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const [customers, activeContracts] = await Promise.all([
      this.admin.customer.findMany({
        where: { tenantId, deletedAt: null },
        include: { _count: { select: { contracts: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.admin.contract.groupBy({
        by: ['customerId'],
        where: { tenantId, status: { in: ['active', 'ending'] } },
        _count: { _all: true },
      }),
    ]);
    const activeByCustomer = new Map(activeContracts.map((c) => [c.customerId, c._count._all]));
    return customers.map((c) => {
      const name =
        c.customerType === 'business'
          ? (c.companyName ?? c.email ?? '—')
          : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || '—';
      return {
        id: c.id,
        name,
        customerType: c.customerType,
        email: c.email,
        phone: c.phone,
        documentType: c.documentType,
        documentNumber: c.documentNumber,
        kycVerified: c.kycVerified,
        contractCount: c._count.contracts,
        activeContractCount: activeByCustomer.get(c.id) ?? 0,
        createdAt: c.createdAt.toISOString(),
      };
    });
  }

  /** Locales (facilities) del tenant con nº de trasteros y ocupados. */
  async listFacilities(tenantId: string): Promise<AdminTenantFacilityDto[]> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const [facilities, occupied] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId, deletedAt: null },
        include: { _count: { select: { units: true } } },
        orderBy: { name: 'asc' },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId'],
        where: { tenantId, status: 'occupied' },
        _count: { _all: true },
      }),
    ]);
    const occupiedByFacility = new Map(occupied.map((o) => [o.facilityId, o._count._all]));
    return facilities.map((f) => ({
      id: f.id,
      name: f.name,
      city: f.city,
      address: f.address,
      unitCount: f._count.units,
      occupiedCount: occupiedByFacility.get(f.id) ?? 0,
    }));
  }

  /** Trasteros (units) de un local del tenant, con m², precio, estado y tipo. */
  async listUnits(tenantId: string, facilityId: string): Promise<AdminTenantUnitDto[]> {
    const facility = await this.admin.facility.findFirst({
      where: { id: facilityId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!facility) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
    const units = await this.admin.unit.findMany({
      where: { facilityId },
      include: { unitType: { select: { name: true } } },
      orderBy: { code: 'asc' },
    });
    return units.map((u) => ({
      id: u.id,
      code: u.code,
      unitTypeName: u.unitType.name,
      areaM2: u.areaM2 === null ? null : Number(u.areaM2),
      basePriceMonthly: Number(u.basePriceMonthly),
      status: u.status,
    }));
  }

  // =============================== actions =================================

  async suspend(tenantId: string, meta: ActionMeta): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (tenant.status === 'suspended') {
      return this.detail(tenantId);
    }
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended' },
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.suspended',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        superAdminId: meta.superAdminId,
        reason: meta.reason,
        previousStatus: tenant.status,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.suspended',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { reason: meta.reason, previousStatus: tenant.status },
    });
    return this.detail(tenantId);
  }

  async reactivate(tenantId: string, meta: ActionMeta): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (tenant.status !== 'suspended') {
      // Idempotente: si ya esta activo o en trial no hacemos nada.
      return this.detail(tenantId);
    }
    // Determinar status destino: si el trial sigue vigente, vuelve a trial;
    // si no, pasa a active.
    const targetStatus =
      tenant.trialEndsAt && tenant.trialEndsAt.getTime() > Date.now() ? 'trial' : 'active';

    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { status: targetStatus },
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.reactivated',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        superAdminId: meta.superAdminId,
        reason: meta.reason,
        newStatus: targetStatus,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.reactivated',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { reason: meta.reason, newStatus: targetStatus },
    });
    return this.detail(tenantId);
  }

  async extendTrial(tenantId: string, args: ExtendTrialArgs): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    const base =
      tenant.trialEndsAt && tenant.trialEndsAt.getTime() > Date.now()
        ? tenant.trialEndsAt
        : new Date();
    const newTrialEndsAt = new Date(base.getTime() + args.days * 24 * 60 * 60 * 1000);

    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        trialEndsAt: newTrialEndsAt,
        ...(tenant.status === 'cancelled' ? {} : { status: 'trial' }),
      },
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.trial_extended',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        superAdminId: args.superAdminId,
        reason: args.reason,
        days: args.days,
        previousTrialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
        newTrialEndsAt: newTrialEndsAt.toISOString(),
      },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action: 'admin.tenant.trial_extended',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes: {
        reason: args.reason,
        days: args.days,
        previousTrialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
        newTrialEndsAt: newTrialEndsAt.toISOString(),
      },
    });
    return this.detail(tenantId);
  }

  /**
   * Cambia el plan de suscripcion de un tenant (super admin). Util para
   * mover un tenant entre planes (free/starter/pro) — controla, vía
   * `PLAN_FEATURES`, qué modulos premium ve. No toca Stripe (cambio manual).
   */
  /** Checklist de puesta a punto del tenant (derivado de sus datos). */
  async getOnboarding(tenantId: string): Promise<AdminOnboardingDto> {
    await this.findOrThrow(tenantId);
    const [tenant, ownerVerified, facilities, units, customers, contracts, aeat] =
      await Promise.all([
        this.admin.tenant.findUnique({
          where: { id: tenantId },
          select: { portalLogoUrl: true, portalBrandColor: true },
        }),
        this.admin.user.count({
          where: { tenantId, role: 'owner', emailVerifiedAt: { not: null } },
        }),
        this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
        this.admin.unit.count({ where: { tenantId } }),
        this.admin.customer.count({ where: { tenantId, deletedAt: null } }),
        this.admin.contract.count({ where: { tenantId } }),
        this.admin.tenantAeatCredential.count({ where: { tenantId, revokedAt: null } }),
      ]);
    const items: AdminOnboardingDto['items'] = [
      { key: 'email_verified', label: 'Email del propietario verificado', done: ownerVerified > 0 },
      { key: 'facility', label: 'Primer local creado', done: facilities > 0 },
      { key: 'unit', label: 'Primer trastero creado', done: units > 0 },
      { key: 'customer', label: 'Primer inquilino dado de alta', done: customers > 0 },
      { key: 'contract', label: 'Primer contrato', done: contracts > 0 },
      {
        key: 'branding',
        label: 'Marca del portal configurada',
        done: Boolean(tenant?.portalLogoUrl || tenant?.portalBrandColor),
      },
      { key: 'verifactu', label: 'Veri*Factu (certificado AEAT)', done: aeat > 0 },
    ];
    return { items, completed: items.filter((i) => i.done).length, total: items.length };
  }

  /** Features del tenant: plan + overrides + efectivas. */
  async getFeatures(tenantId: string): Promise<AdminTenantFeaturesDto> {
    await this.findOrThrow(tenantId);
    const [subscription, rows] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId },
        select: { feature: true, enabled: true },
      }),
    ]);
    const planSlug = subscription?.plan.slug ?? null;
    const overrides = rows as { feature: TenantFeature; enabled: boolean }[];
    const planFeatures = subscription ? resolvePlanFeatures(subscription.plan) : [];
    return {
      planSlug,
      planFeatures,
      overrides,
      effective: effectiveFeaturesFromList(planFeatures, overrides),
    };
  }

  /** Reescribe los overrides de feature del tenant (los redundantes se descartan). */
  async setFeatures(
    tenantId: string,
    args: { overrides: { feature: TenantFeature; enabled: boolean }[] } & ActionMeta,
  ): Promise<AdminTenantFeaturesDto> {
    await this.findOrThrow(tenantId);
    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: { select: { slug: true, tenantFeatures: true } } },
    });
    const planFeatures = new Set(subscription ? resolvePlanFeatures(subscription.plan) : []);
    // Solo guardamos los overrides que cambian algo respecto al plan.
    const effectiveOverrides = args.overrides.filter(
      (o) => o.enabled !== planFeatures.has(o.feature),
    );
    // Solo gestiona los overrides de cortesía (`source='manual'`); NO toca los
    // activados por add-ons (`source='addon'`), que gestiona el motor de add-ons.
    await this.admin.$transaction([
      this.admin.tenantFeatureOverride.deleteMany({ where: { tenantId, source: 'manual' } }),
      ...(effectiveOverrides.length
        ? [
            this.admin.tenantFeatureOverride.createMany({
              data: effectiveOverrides.map((o) => ({
                tenantId,
                feature: o.feature,
                enabled: o.enabled,
                source: 'manual',
              })),
            }),
          ]
        : []),
    ]);
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.features_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: args.superAdminId, overrides: effectiveOverrides },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action: 'admin.tenant.features_changed',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes: { overrides: effectiveOverrides },
    });
    return this.getFeatures(tenantId);
  }

  /** Cola de dominios propios (pendientes de activar + activos). */
  async listCustomDomains(): Promise<AdminCustomDomainDto[]> {
    const tenants = await this.admin.tenant.findMany({
      where: { customDomain: { not: null }, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        customDomain: true,
        customDomainVerifiedAt: true,
        subscription: { select: { plan: { select: { slug: true } } } },
      },
      orderBy: [{ customDomainVerifiedAt: 'asc' }, { name: 'asc' }],
    });
    return tenants.map((t) => ({
      tenantId: t.id,
      tenantName: t.name,
      tenantSlug: t.slug,
      customDomain: t.customDomain!,
      verifiedAt: t.customDomainVerifiedAt?.toISOString() ?? null,
      planSlug: t.subscription?.plan.slug ?? 'free',
    }));
  }

  /** Activa (verifica) el dominio propio de un tenant tras configurar NPM. */
  async verifyCustomDomain(tenantId: string, args: ActionMeta): Promise<AdminCustomDomainDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (!tenant.customDomain) {
      throw new NotFoundException({ code: 'no_custom_domain', message: 'Sin dominio propio' });
    }
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { customDomainVerifiedAt: new Date() },
    });
    await this.traceCustomDomain(
      tenantId,
      'admin.tenant.custom_domain_verified',
      tenant.customDomain,
      args,
    );
    return (await this.listCustomDomains()).find((d) => d.tenantId === tenantId)!;
  }

  /** Desactiva (revoca) el dominio propio: deja de servirse bajo la marca. */
  async revokeCustomDomain(tenantId: string, args: ActionMeta): Promise<AdminCustomDomainDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (!tenant.customDomain) {
      throw new NotFoundException({ code: 'no_custom_domain', message: 'Sin dominio propio' });
    }
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { customDomainVerifiedAt: null },
    });
    await this.traceCustomDomain(
      tenantId,
      'admin.tenant.custom_domain_revoked',
      tenant.customDomain,
      args,
    );
    return (await this.listCustomDomains()).find((d) => d.tenantId === tenantId)!;
  }

  private async traceCustomDomain(
    tenantId: string,
    action: string,
    domain: string,
    args: ActionMeta,
  ): Promise<void> {
    const changes = { customDomain: domain };
    await this.audit.write({
      tenantId,
      userId: null,
      action,
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: args.superAdminId, ...changes },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes,
    });
  }

  async changePlan(
    tenantId: string,
    args: { planSlug: string; reason: string } & ActionMeta,
  ): Promise<AdminTenantDto> {
    await this.findOrThrow(tenantId);
    const plan = await this.admin.subscriptionPlan.findUnique({
      where: { slug: args.planSlug },
    });
    if (!plan) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    if (!plan.isActive) {
      throw new BadRequestException({
        code: 'plan_not_active',
        message: 'Ese plan está desactivado; no se puede asignar.',
      });
    }
    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!subscription) {
      throw new NotFoundException({
        code: 'subscription_not_found',
        message: 'Suscripcion no encontrada',
      });
    }
    const previousSlug = subscription.plan.slug;
    await this.admin.tenantSubscription.update({
      where: { tenantId },
      data: { planId: plan.id },
    });
    const changes = { reason: args.reason, previousPlan: previousSlug, newPlan: plan.slug };
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.plan_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: args.superAdminId, ...changes },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action: 'admin.tenant.plan_changed',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes,
    });
    return this.detail(tenantId);
  }

  /**
   * Impacto de cambiar de plan, SIN aplicar nada: delta de precio, add-ons que
   * quedarían redundantes (su feature ya la incluye el plan nuevo) y recursos
   * cuyo uso superaría los límites del plan nuevo.
   */
  async changePlanPreview(tenantId: string, planSlug: string): Promise<AdminChangePlanPreviewDto> {
    await this.findOrThrow(tenantId);
    const [newPlan, subscription, units, facilities, users, addons] = await Promise.all([
      this.admin.subscriptionPlan.findUnique({ where: { slug: planSlug } }),
      this.admin.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } }),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId, suspendedAt: null },
        include: { addon: { select: { name: true, feature: true } } },
      }),
    ]);
    if (!newPlan) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    if (!subscription) {
      throw new NotFoundException({
        code: 'subscription_not_found',
        message: 'Suscripcion no encontrada',
      });
    }

    const newFeatures = new Set<string>(resolvePlanFeatures(newPlan));
    const redundantAddons = addons
      .filter((a) => a.addon.feature && newFeatures.has(a.addon.feature))
      .map((a) => ({ name: a.addon.name, feature: a.addon.feature as string }));

    const overLimits: { resource: string; used: number; limit: number }[] = [];
    const check = (resource: string, used: number, limit: number | null) => {
      if (limit !== null && used > limit) overLimits.push({ resource, used, limit });
    };
    check('units', units, newPlan.maxUnits);
    check('facilities', facilities, newPlan.maxFacilities);
    check('users', users, newPlan.maxUsers);

    const currentPrice = Number(subscription.plan.priceMonthly);
    const newPrice = Number(newPlan.priceMonthly);
    return {
      currentPlanName: subscription.plan.name,
      currentPriceMonthly: currentPrice,
      newPlanName: newPlan.name,
      newPriceMonthly: newPrice,
      priceDelta: Math.round((newPrice - currentPrice) * 100) / 100,
      isDowngrade: newPrice < currentPrice,
      newPlanActive: newPlan.isActive,
      redundantAddons,
      overLimits,
    };
  }

  /**
   * Anonimizacion completa de un tenant (RGPD, derecho al olvido al darse de
   * baja). Irreversible. En una sola `$transaction` (bypass RLS porque es
   * cross-tenant):
   *   1. Anonimiza TODOS los customers del tenant con los mismos placeholders
   *      que `RgpdService.anonymizeCustomer` (sin la guarda de contrato activo:
   *      el tenant entero se da de baja). Preserva sus `invoices` por
   *      obligacion fiscal (Veri*Factu + Ley 58/2003).
   *   2. Borra `customer_documents` y `payment_methods` (no obligatorios
   *      fiscalmente).
   *   3. Anonimiza el staff (`users`): email unico irreversible — lo exige el
   *      `@@unique([tenantId, email])` —, `fullName`/`phone` borrados, 2FA
   *      desactivado y `passwordHash` sustituido por el hash de un secreto
   *      aleatorio irrecuperable (defensa adicional sobre `isActive=false`).
   *   4. Revoca todas las `sessions` activas del tenant.
   *   5. Marca el tenant `cancelled` + `deletedAt` y borra su PII de contacto
   *      (`billingEmail`, `taxId`).
   *
   * Se preservan `audit_logs` (registro legal de la operativa) y la propia
   * fila del tenant (no se borra fisicamente: la FK de invoices/audit_logs es
   * `NOT NULL`). Deja rastro en `audit_logs` del tenant + `super_admin_audit_logs`.
   */
  async anonymize(tenantId: string, meta: ActionMeta): Promise<AnonymizeTenantResult> {
    await this.findOrThrow(tenantId);

    // Hash de un secreto aleatorio que nadie conoce: invalida la credencial
    // sin dejar un `passwordHash` mal formado que rompa `argon2.verify`.
    const placeholderHash = await argonHash(randomBytes(32).toString('hex'));
    const now = new Date();

    const counts = await this.admin.$transaction(async (tx) => {
      const customers = await tx.customer.updateMany({
        where: { tenantId },
        data: {
          firstName: ANON,
          lastName: '',
          companyName: ANON,
          email: null,
          phone: null,
          address: null,
          city: null,
          postalCode: null,
          documentNumber: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          notes: null,
          tags: [],
          portalAccessEnabled: false,
          portalPasswordHash: null,
          deletedAt: now,
        },
      });

      await tx.customerDocument.deleteMany({ where: { tenantId } });
      await tx.paymentMethod.deleteMany({ where: { tenantId } });

      // PII fuera de customers: leads (nombre/email/telefono/mensaje) y
      // communications (recipient + cuerpos renderizados + variables, que
      // arrastran datos personales del snapshot Handlebars).
      const leads = await tx.lead.updateMany({
        where: { tenantId },
        data: {
          firstName: ANON,
          lastName: '',
          companyName: ANON,
          email: null,
          phone: null,
          message: null,
          metadata: {},
          deletedAt: now,
        },
      });
      const communications = await tx.communication.updateMany({
        where: { tenantId },
        data: {
          recipient: ANON,
          subject: ANON,
          bodyText: ANON,
          bodyHtml: null,
          variables: {},
          errorMessage: null,
        },
      });

      const users = await tx.user.findMany({ where: { tenantId }, select: { id: true } });
      for (const user of users) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            email: `anon-${user.id}@anonymized.invalid`,
            fullName: ANON,
            phone: null,
            passwordHash: placeholderHash,
            twoFactorSecretEncrypted: null,
            twoFactorPendingSecretEncrypted: null,
            twoFactorEnabled: false,
            twoFactorEnrolledAt: null,
            isActive: false,
          },
        });
      }

      await tx.session.deleteMany({ where: { tenantId } });

      await tx.tenant.update({
        where: { id: tenantId },
        data: { status: 'cancelled', deletedAt: now, billingEmail: null, taxId: null },
      });

      return {
        customers: customers.count,
        users: users.length,
        leads: leads.count,
        communications: communications.count,
      };
    });

    const changes = {
      reason: meta.reason,
      anonymizedCustomers: counts.customers,
      anonymizedUsers: counts.users,
      anonymizedLeads: counts.leads,
      anonymizedCommunications: counts.communications,
    };
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.anonymized',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: meta.superAdminId, ...changes },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.anonymized',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes,
    });

    return {
      tenantId,
      anonymizedCustomers: counts.customers,
      anonymizedUsers: counts.users,
    };
  }

  // ============================== helpers ==================================

  private async findOrThrow(tenantId: string) {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'Tenant no encontrado',
      });
    }
    return tenant;
  }

  private toDto(row: {
    id: string;
    name: string;
    slug: string;
    status: string;
    trialEndsAt: Date | null;
    billingEmail: string | null;
    country: string;
    currency: string;
    timezone: string;
    taxId: string | null;
    createdAt: Date;
    subscription: null | {
      status: string;
      currentPeriodEnd: Date | null;
      stripeSubscriptionId: string | null;
      plan: { slug: string; name: string } | null;
    };
    _count: { users: number; customers: number; contracts: number; facilities: number };
  }): AdminTenantDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
      billingEmail: row.billingEmail,
      country: row.country,
      currency: row.currency,
      timezone: row.timezone,
      taxId: row.taxId,
      createdAt: row.createdAt.toISOString(),
      userCount: row._count.users,
      customerCount: row._count.customers,
      contractCount: row._count.contracts,
      facilityCount: row._count.facilities,
      subscription: row.subscription
        ? {
            planSlug: row.subscription.plan?.slug ?? null,
            planName: row.subscription.plan?.name ?? null,
            status: row.subscription.status,
            currentPeriodEnd: row.subscription.currentPeriodEnd
              ? row.subscription.currentPeriodEnd.toISOString()
              : null,
            stripeSubscriptionId: row.subscription.stripeSubscriptionId,
          }
        : null,
    };
  }
}
