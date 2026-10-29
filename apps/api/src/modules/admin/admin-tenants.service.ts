import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';
import {
  FEATURE_LABELS,
  TenantFeatures,
  effectiveFeaturesFromList,
  missingFiscalData,
  resolvePlanFeatures,
  NON_CASH_PAYMENT_METHODS,
} from '@storageos/shared';

import { TtlCache } from '../../common/cache/ttl-cache';
import { zonedNextDayStart } from '../../common/format';
import { liveOverrideWhere } from '../../common/tenant-features';
import { anonymizeWhatsappConversations } from '../../common/whatsapp-anonymize';
import { AuditService } from '../auth/audit.service';
import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type { InvoiceStatus, Prisma } from '@storageos/database';
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
  AdminTenantsListResponseDto,
  AdminTenantFacilityDto,
  AdminTenantFeaturesDto,
  AdminChangePlanPreviewDto,
  AdminTenantHealthDto,
  AdminTenantHealthFactorDto,
  AdminTenantHealthLevel,
  AdminTenantInvoicingDto,
  AdminTenantNotesDto,
  UpdateTenantNotesInput,
  AdminTenantUnitDto,
  AdminTenantUserDto,
  AdminTrialDto,
  TenantFeature,
} from '@storageos/shared';

/** Estados de factura que cuentan como facturación (excluye draft/cancelled). */
const ACCOUNTING_STATUSES: InvoiceStatus[] = [
  'issued',
  'paid',
  'overdue',
  'refunded',
  'partially_refunded',
  'rectified',
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
  /** Motivo de baja (churn) al suspender; alimenta el reporte churn por razón. */
  churnReason?: string | null;
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
  private readonly logger = new Logger(AdminTenantsService.name);
  /** Caché de 60 s de las agregaciones cross-tenant de salud y adopción. */
  private readonly healthCache = new TtlCache<AdminTenantHealthDto[]>();
  private readonly adoptionCache = new TtlCache<AdminAdoptionDto>();

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly files: FilesService,
    private readonly saasBilling: BillingSaasService,
  ) {}

  // =============================== read ====================================

  async list(filters: {
    search?: string;
    status?: string;
    tag?: string;
    cursor?: string;
    limit?: number;
  }): Promise<AdminTenantsListResponseDto> {
    // Paginación por cursor: a 500+ tenants la lista completa (con 4 _count por
    // fila) es cara y pesada. Cursor estable por (createdAt desc, id desc).
    const take = Math.min(Math.max(filters.limit ?? 30, 1), 100);
    if (filters.status && !['trial', 'active', 'suspended', 'cancelled'].includes(filters.status)) {
      throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
    }
    const rows = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        ...(filters.status
          ? { status: filters.status as 'trial' | 'active' | 'suspended' | 'cancelled' }
          : {}),
        // Filtro por etiqueta estratégica (los tags viven en `tenant.tags String[]`).
        ...(filters.tag ? { tags: { has: filters.tag } } : {}),
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1, // 1 extra para saber si hay página siguiente
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      items: page.map((r) => this.toDto(r)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Etiquetas estratégicas distintas en uso por los tenants (para alimentar
   * el selector de filtro/segmentación). Aplanamos los `tags` de todos los
   * tenants vivos y devolvemos el conjunto ordenado alfabéticamente.
   */
  async listTags(): Promise<string[]> {
    const rows = await this.admin.tenant.findMany({
      where: { deletedAt: null, tags: { isEmpty: false } },
      select: { tags: true },
    });
    const set = new Set<string>();
    for (const r of rows) for (const t of r.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
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
    // Propietario (quien registró la cuenta) → permite activar/reenviar el email
    // de activación desde el panel si aún no ha verificado.
    const owner = await this.admin.user.findFirst({
      where: { tenantId, role: 'owner' },
      select: { id: true, email: true, fullName: true, emailVerifiedAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...this.toDto(row),
      owner: owner
        ? {
            userId: owner.id,
            email: owner.email,
            fullName: owner.fullName,
            emailVerified: owner.emailVerifiedAt !== null,
          }
        : null,
    };
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

    // Los que el super admin ha «ignorado» unos días no salen.
    const notSnoozed: Prisma.TenantWhereInput = {
      OR: [{ riskSnoozedUntil: null }, { riskSnoozedUntil: { lte: now } }],
    };
    const [trials, pastDue, activeTenants, snoozedCount, health] = await Promise.all([
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: 'trial',
          trialEndsAt: { gte: now, lte: in7d },
          ...notSnoozed,
        },
        include: planInclude,
        orderBy: { trialEndsAt: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          billingExempt: false,
          subscription: { status: 'past_due' },
          ...notSnoozed,
        },
        include: planInclude,
        orderBy: { name: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: { deletedAt: null, billingExempt: false, status: 'active', ...notSnoozed },
        include: planInclude,
        orderBy: { name: 'asc' },
      }),
      this.admin.tenant.count({
        where: { deletedAt: null, billingExempt: false, riskSnoozedUntil: { gt: now } },
      }),
      this.getTenantsHealth(),
    ]);

    // Rendimiento: el groupBy de lastLoginAt se acota a los tenants activos ya
    // cargados (antes escaneaba TODA la tabla `users`; a 500 tenants con miles
    // de usuarios cada uno, un full-scan cada 60s vía el badge del sidebar).
    const activeIds = activeTenants.map((t) => t.id);
    const lastLogins = activeIds.length
      ? await this.admin.user.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: activeIds }, isActive: true },
          _max: { lastLoginAt: true },
        })
      : [];

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

    // Salud «en riesgo» o «dormida» que no sale ya arriba: el mismo criterio que
    // la página de Salud, para que las dos listas no se contradigan.
    const listed = new Set([...trialExpiring, ...pastDueList, ...inactive].map((t) => t.id));
    const snoozed = new Set(
      (
        await this.admin.tenant.findMany({
          where: { riskSnoozedUntil: { gt: now } },
          select: { id: true },
        })
      ).map((t) => t.id),
    );
    const exempt = new Set(
      (
        await this.admin.tenant.findMany({ where: { billingExempt: true }, select: { id: true } })
      ).map((t) => t.id),
    );
    const lowHealth = health
      .filter(
        (h) =>
          (h.level === 'at_risk' || h.level === 'dormant') &&
          !listed.has(h.tenantId) &&
          !snoozed.has(h.tenantId) &&
          !exempt.has(h.tenantId),
      )
      .map((h) => ({
        id: h.tenantId,
        name: h.name,
        slug: h.slug,
        status: h.status,
        planName: h.planName,
        reason: 'low_health',
        since: h.lastActivityAt,
        detail: `Salud ${h.score} · ${
          [...h.factors].sort((a, b) => a.score - b.score)[0]?.detail ?? ''
        }`,
      }));

    return { trialExpiring, pastDue: pastDueList, inactive, lowHealth, snoozedCount };
  }

  /**
   * Todos los tenants en trial, ordenados por fecha de expiración (los que
   * antes vencen, primero). Incluye la última actividad del equipo para detectar
   * los que nunca han usado la plataforma (candidatos que probablemente no
   * convertirán salvo que se les active).
   */
  async listTrials(): Promise<AdminTrialDto[]> {
    const now = new Date();
    const trials = await this.admin.tenant.findMany({
      where: { deletedAt: null, billingExempt: false, status: 'trial' },
      include: { subscription: { include: { plan: { select: { name: true } } } } },
      orderBy: { trialEndsAt: 'asc' },
    });
    if (trials.length === 0) return [];
    const ids = trials.map((t) => t.id);
    const [logins, facilities, units, contracts] = await Promise.all([
      this.admin.user.groupBy({
        by: ['tenantId'],
        _max: { lastLoginAt: true },
        where: { tenantId: { in: ids }, isActive: true },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.unit.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids } },
        _count: { _all: true },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, deletedAt: null, status: { in: ['active', 'ending'] } },
        _count: { _all: true },
      }),
    ]);
    const loginMap = new Map(logins.map((l) => [l.tenantId, l._max.lastLoginAt ?? null]));
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const facBy = count(facilities);
    const unitBy = count(units);
    const contractBy = count(contracts);
    const DAY_MS = 24 * 60 * 60 * 1000;
    return trials.map((t) => {
      const last = loginMap.get(t.id) ?? null;
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        planName: t.subscription?.plan?.name ?? null,
        trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
        daysLeft: t.trialEndsAt
          ? Math.ceil((t.trialEndsAt.getTime() - now.getTime()) / DAY_MS)
          : null,
        createdAt: t.createdAt.toISOString(),
        lastActivityAt: last?.toISOString() ?? null,
        neverUsed: !last,
        facilities: facBy.get(t.id) ?? 0,
        units: unitBy.get(t.id) ?? 0,
        activeContracts: contractBy.get(t.id) ?? 0,
      };
    });
  }

  // --- Notas estratégicas y LTV (customer success) -----------------------

  async getNotes(tenantId: string): Promise<AdminTenantNotesDto> {
    const t = await this.findOrThrow(tenantId);
    return {
      ltvTier: t.ltvTier ?? null,
      strategicNotes: t.strategicNotes ?? null,
      tags: t.tags ?? [],
    };
  }

  async updateNotes(
    tenantId: string,
    input: UpdateTenantNotesInput,
    meta: ActionMeta,
  ): Promise<AdminTenantNotesDto> {
    await this.findOrThrow(tenantId);
    const updated = await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        ...(input.ltvTier !== undefined ? { ltvTier: input.ltvTier || null } : {}),
        ...(input.strategicNotes !== undefined
          ? { strategicNotes: input.strategicNotes || null }
          : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.notes_updated',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { ltvTier: updated.ltvTier, tags: updated.tags },
    });
    return {
      ltvTier: updated.ltvTier ?? null,
      strategicNotes: updated.strategicNotes ?? null,
      tags: updated.tags ?? [],
    };
  }

  // --- Health score por tenant -------------------------------------------

  /**
   * Health score 0-100 de cada tenant activo/trial, ordenado de menor (más
   * urgente) a mayor. Combina 4 señales ponderadas: actividad del equipo,
   * facturación reciente, estado de la suscripción y adopción (contratos +
   * locales). Solo lectura/agregación cross-tenant.
   */
  getTenantsHealth(): Promise<AdminTenantHealthDto[]> {
    return this.healthCache.get('all', () => this.computeTenantsHealth());
  }

  private async computeTenantsHealth(): Promise<AdminTenantHealthDto[]> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, status: { in: ['active', 'trial'] } },
      include: { subscription: { include: { plan: { select: { name: true } } } } },
    });
    const signals = await this.healthSignals(null);
    const result = tenants.map((t) => this.scoreTenant(this.healthInput(t, signals)));
    await this.saveHealthSnapshots(result);
    // Más urgentes primero (menor score).
    result.sort((a, b) => a.score - b.score);
    return result;
  }

  /** Health score de un tenant concreto (404 si no existe). */
  async getTenantHealth(tenantId: string): Promise<AdminTenantHealthDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      include: { subscription: { include: { plan: { select: { name: true } } } } },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const signals = await this.healthSignals(tenantId);
    return this.scoreTenant(this.healthInput(tenant, signals));
  }

  /**
   * Señales de la salud por tenant (de todos o de uno): último acceso del
   * equipo, facturas en 30 y 60 días, contratos y locales, tickets sin
   * responder, uso del área de clientes por sus inquilinos y la foto del mes
   * pasado (para la tendencia).
   */
  private async healthSignals(tenantId: string | null) {
    const DAY_MS = 86_400_000;
    const now = Date.now();
    const since30d = new Date(now - 30 * DAY_MS);
    const since60d = new Date(now - 60 * DAY_MS);
    const since90d = new Date(now - 90 * DAY_MS);
    const ticketStale = new Date(now - 48 * 60 * 60 * 1000);
    const prevMonth = new Date(
      Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1),
    );
    const scope: { tenantId?: string } = tenantId ? { tenantId } : {};
    const liveCustomer: Prisma.CustomerWhereInput = {
      ...scope,
      deletedAt: null,
      contracts: { some: { status: { in: ['active', 'ending'] }, deletedAt: null } },
    };
    const [
      lastLogins,
      invoices30,
      invoices60,
      activeContracts,
      facilities,
      tickets,
      customers,
      portalUsers,
      prevSnapshots,
    ] = await Promise.all([
      this.admin.user.groupBy({
        by: ['tenantId'],
        where: { ...scope, isActive: true },
        _max: { lastLoginAt: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: {
          ...scope,
          deletedAt: null,
          status: { in: ['issued', 'paid', 'overdue'] },
          issueDate: { gte: since30d },
        },
        _count: { _all: true },
      }),
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: {
          ...scope,
          deletedAt: null,
          status: { in: ['issued', 'paid', 'overdue'] },
          issueDate: { gte: since60d },
        },
        _count: { _all: true },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null, status: { in: ['active', 'ending'] } },
        _count: { _all: true },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null },
        _count: { _all: true },
      }),
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
        where: { ...liveCustomer, portalLastSeenAt: { gte: since90d } },
        _count: { _all: true },
      }),
      this.admin.tenantHealthSnapshot.findMany({
        where: { ...scope, month: prevMonth },
        select: { tenantId: true, score: true },
      }),
    ]);
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.tenantId, r._count._all]));
    return {
      lastLogin: new Map(lastLogins.map((l) => [l.tenantId, l._max.lastLoginAt ?? null])),
      invoices30: count(invoices30),
      invoices60: count(invoices60),
      contracts: count(activeContracts),
      facilities: count(facilities),
      staleTickets: count(tickets),
      customers: count(customers),
      portalUsers: count(portalUsers),
      prevScore: new Map(prevSnapshots.map((r) => [r.tenantId, r.score])),
    };
  }

  private healthInput(
    t: {
      id: string;
      name: string;
      slug: string;
      status: string;
      trialEndsAt: Date | null;
      subscription: {
        status: string;
        cancelAtPeriodEnd: boolean;
        plan: { name: string } | null;
      } | null;
    },
    s: Awaited<ReturnType<AdminTenantsService['healthSignals']>>,
  ) {
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      planName: t.subscription?.plan?.name ?? null,
      subStatus: t.subscription?.status ?? null,
      cancelAtPeriodEnd: t.subscription?.cancelAtPeriodEnd ?? false,
      trialEndsAt: t.trialEndsAt,
      lastLoginAt: s.lastLogin.get(t.id) ?? null,
      recentInvoices: s.invoices30.get(t.id) ?? 0,
      invoices60d: s.invoices60.get(t.id) ?? 0,
      activeContracts: s.contracts.get(t.id) ?? 0,
      facilities: s.facilities.get(t.id) ?? 0,
      staleTickets: s.staleTickets.get(t.id) ?? 0,
      customers: s.customers.get(t.id) ?? 0,
      portalUsers: s.portalUsers.get(t.id) ?? 0,
      previousScore: s.prevScore.get(t.id) ?? null,
    };
  }

  /** Guarda la foto del mes en curso (se reescribe con cada cálculo). */
  private async saveHealthSnapshots(rows: AdminTenantHealthDto[]): Promise<void> {
    if (rows.length === 0) return;
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    await this.admin
      .$transaction([
        this.admin.tenantHealthSnapshot.deleteMany({
          where: { month, tenantId: { in: rows.map((r) => r.tenantId) } },
        }),
        this.admin.tenantHealthSnapshot.createMany({
          data: rows.map((r) => ({ tenantId: r.tenantId, month, score: r.score, level: r.level })),
        }),
      ])
      .catch(() => undefined);
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
    invoices60d: number;
    activeContracts: number;
    facilities: number;
    staleTickets: number;
    customers: number;
    portalUsers: number;
    previousScore: number | null;
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
    // Con contratos activos y sin facturas en 60 días, algo falla en su facturación.
    const stalledBilling = s.activeContracts > 0 && s.invoices60d === 0;
    const billing = stalledBilling
      ? 0
      : s.recentInvoices >= 5
        ? 100
        : s.recentInvoices >= 2
          ? 75
          : s.recentInvoices >= 1
            ? 50
            : 0;
    const billingDetail = stalledBilling
      ? `Sin facturas en 60 días con ${s.activeContracts} contrato(s) activo(s)`
      : `${s.recentInvoices} factura(s) en 30 días`;

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
      if (!s.trialEndsAt) {
        subscription = 70;
        subDetail = 'En prueba, sin fecha de fin';
      } else {
        subscription = trialDaysLeft > 7 ? 70 : 40;
        subDetail =
          trialDaysLeft > 0 ? `Trial: ${Math.ceil(trialDaysLeft)} d restantes` : 'Trial vencido';
      }
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

    // 5) Área de clientes: inquilinos con contrato que han entrado en 90 días.
    const portalPct = s.customers > 0 ? (s.portalUsers / s.customers) * 100 : null;
    const portal =
      portalPct === null
        ? 50
        : portalPct >= 50
          ? 100
          : portalPct >= 25
            ? 70
            : portalPct > 0
              ? 40
              : 10;
    const portalDetail =
      portalPct === null
        ? 'Sin inquilinos con contrato'
        : `${Math.round(portalPct)} % de sus inquilinos entró en 90 días`;

    // 6) Soporte: tickets abiertos sin primera respuesta en más de 48 h.
    const support = s.staleTickets === 0 ? 100 : s.staleTickets === 1 ? 40 : 10;
    const supportDetail =
      s.staleTickets === 0
        ? 'Sin tickets esperando respuesta'
        : `${s.staleTickets} ticket(s) sin responder en más de 48 h`;

    const factors: AdminTenantHealthFactorDto[] = [
      {
        key: 'engagement',
        label: 'Actividad del equipo',
        score: engagement,
        weight: 0.3,
        detail: engagementDetail,
      },
      {
        key: 'billing',
        label: 'Facturación reciente',
        score: billing,
        weight: 0.2,
        detail: billingDetail,
      },
      {
        key: 'subscription',
        label: 'Suscripción',
        score: subscription,
        weight: 0.2,
        detail: subDetail,
      },
      { key: 'adoption', label: 'Adopción', score: adoption, weight: 0.15, detail: adoptionDetail },
      {
        key: 'portal',
        label: 'Área de clientes',
        score: portal,
        weight: 0.1,
        detail: portalDetail,
      },
      { key: 'support', label: 'Soporte', score: support, weight: 0.05, detail: supportDetail },
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
      trend: s.previousScore !== null ? score - s.previousScore : null,
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
  getAdoption(): Promise<AdminAdoptionDto> {
    return this.adoptionCache.get('all', () => this.computeAdoption());
  }

  private async computeAdoption(): Promise<AdminAdoptionDto> {
    const [
      tenants,
      plans,
      aiRows,
      bankRows,
      rentRows,
      insuranceRows,
      credentialRows,
      facialCredentialRows,
      deviceRows,
      cameraRows,
      automationRows,
      sepaRows,
      unitRows,
      facilityRows,
      userRows,
      collectionsRows,
      blogRows,
      housingRows,
      ownerRows,
      overrideRows,
      whatsappRows,
      areaPageRows,
      reminderRows,
      inviteRows,
      addonRows,
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
      this.admin.accessCredential.groupBy({
        by: ['tenantId'],
        where: { method: 'face' },
        _count: { _all: true },
      }),
      this.admin.accessDevice.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.cameraDevice.groupBy({ by: ['tenantId'], _count: { _all: true } }),
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
      // Usuarios como los cuenta el límite del plan: activos + invitaciones pendientes.
      this.admin.user.groupBy({
        by: ['tenantId'],
        where: { isActive: true },
        _count: { _all: true },
      }),
      this.admin.delinquencyCase.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.blogPost.groupBy({ by: ['tenantId'], _count: { _all: true } }),
      this.admin.unitType.groupBy({
        by: ['tenantId'],
        where: { propertyKind: 'housing' },
        _count: { _all: true },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ownerId: { not: null }, deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.tenantFeatureOverride.findMany({
        select: { tenantId: true, feature: true, enabled: true },
      }),
      this.admin.tenantWhatsappSettings.findMany({
        where: { enabled: true },
        select: { tenantId: true },
      }),
      this.admin.webAreaPage.groupBy({
        by: ['tenantId'],
        where: { isPublished: true },
        _count: { _all: true },
      }),
      this.admin.businessReminder.groupBy({
        by: ['tenantId'],
        where: { status: { in: ['active', 'paused'] } },
        _count: { _all: true },
      }),
      this.admin.invitation.groupBy({
        by: ['tenantId'],
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        _count: { _all: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { suspendedAt: null },
        select: {
          tenantId: true,
          priceMonthly: true,
          quantity: true,
          addon: { select: { grantsUnits: true, grantsFacilities: true, grantsUsers: true } },
        },
      }),
    ]);

    const countMap = (
      rows: { tenantId: string; _count: { _all: number } }[],
    ): Map<string, number> => new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const ai = countMap(aiRows);
    const bank = countMap(bankRows);
    const rent = countMap(rentRows);
    const insurance = countMap(insuranceRows);
    const credentials = countMap(credentialRows);
    const facialCredentials = countMap(facialCredentialRows);
    const devices = countMap(deviceRows);
    const cameras = countMap(cameraRows);
    const automations = countMap(automationRows);
    const sepaEnabled = new Set(sepaRows.map((r) => r.tenantId));
    const units = countMap(unitRows);
    const facilities = countMap(facilityRows);
    const users = countMap(userRows);
    const collections = countMap(collectionsRows);
    const blogPosts = countMap(blogRows);
    const housing = countMap(housingRows);
    const ownedFacilities = countMap(ownerRows);
    const whatsappEnabled = new Set(whatsappRows.map((r) => r.tenantId));
    const areaPages = countMap(areaPageRows);
    const reminders = countMap(reminderRows);
    const invites = countMap(inviteRows);
    // Extras activos: lo que suman al mes y la capacidad que añaden.
    const addonsByTenant = new Map<
      string,
      { monthly: number; units: number; facilities: number; users: number }
    >();
    for (const a of addonRows) {
      const e = addonsByTenant.get(a.tenantId) ?? { monthly: 0, units: 0, facilities: 0, users: 0 };
      e.monthly += Number(a.priceMonthly) * a.quantity;
      e.units += (a.addon.grantsUnits ?? 0) * a.quantity;
      e.facilities += (a.addon.grantsFacilities ?? 0) * a.quantity;
      e.users += (a.addon.grantsUsers ?? 0) * a.quantity;
      addonsByTenant.set(a.tenantId, e);
    }
    const plus = (max: number | null, extra: number): number | null =>
      max === null ? null : max + extra;
    const overridesByTenant = new Map<string, { feature: TenantFeature; enabled: boolean }[]>();
    for (const o of overrideRows) {
      const list = overridesByTenant.get(o.tenantId) ?? [];
      list.push({ feature: o.feature as TenantFeature, enabled: o.enabled });
      overridesByTenant.set(o.tenantId, list);
    }
    const tenantById = new Map(tenants.map((t) => [t.id, t]));

    /** Features que el tenant USA de verdad (señal por feature). */
    const usedFeaturesOf = (id: string): Set<TenantFeature> => {
      const s = new Set<TenantFeature>();
      if ((ai.get(id) ?? 0) > 0) s.add('ai_assistant');
      if (sepaEnabled.has(id)) s.add('sepa');
      if ((bank.get(id) ?? 0) > 0) s.add('bank_reconciliation');
      if ((rent.get(id) ?? 0) > 0) s.add('rent_increases');
      if ((insurance.get(id) ?? 0) > 0) s.add('insurance');
      if ((credentials.get(id) ?? 0) > 0 || (devices.get(id) ?? 0) > 0) s.add('access_control');
      if ((cameras.get(id) ?? 0) > 0) s.add('cameras');
      if ((facialCredentials.get(id) ?? 0) > 0) s.add('facial_access');
      if ((automations.get(id) ?? 0) > 0) s.add('automations');
      if ((collections.get(id) ?? 0) > 0) s.add('collections');
      const t = tenantById.get(id);
      if (t?.customDomainVerifiedAt) s.add('custom_domain');
      if ((t && t.webTemplate !== 'default') || (blogPosts.get(id) ?? 0) > 0) {
        s.add('web_premium');
      }
      if ((housing.get(id) ?? 0) > 0) s.add('housing');
      if ((ownedFacilities.get(id) ?? 0) > 0) s.add('multi_owner');
      if (whatsappEnabled.has(id)) s.add('whatsapp_business');
      if ((areaPages.get(id) ?? 0) > 0) s.add('local_seo');
      if ((reminders.get(id) ?? 0) > 0) s.add('business_reminders');
      return s;
    };

    // Planes ordenados por precio asc para elegir el más barato que cubra.
    const sortedPlans = [...plans].sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly));
    // Las features que no entran en ningún plan (solo se venden como extra) no
    // cuentan para recomendar plan: ninguno las cubre y el tenant nunca saldría.
    const sellableInPlans = new Set(plans.flatMap((p) => resolvePlanFeatures(p)));
    // Los extras de capacidad que ya tiene el tenant siguen sumando con otro plan.
    const planCovers = (
      plan: (typeof plans)[number],
      used: Set<TenantFeature>,
      u: number,
      f: number,
      usr: number,
      extra: { units: number; facilities: number; users: number },
    ): boolean => {
      const feats = resolvePlanFeatures(plan);
      for (const ft of used) {
        if (sellableInPlans.has(ft) && !feats.includes(ft)) return false;
      }
      const maxU = plus(plan.maxUnits, extra.units);
      const maxF = plus(plan.maxFacilities, extra.facilities);
      const maxUsr = plus(plan.maxUsers, extra.users);
      if (maxU !== null && u > maxU) return false;
      if (maxF !== null && f > maxF) return false;
      if (maxUsr !== null && usr > maxUsr) return false;
      return true;
    };

    const tenantDtos: AdminTenantAdoptionDto[] = tenants.map((t) => {
      const plan = t.subscription?.plan ?? null;
      const planSlug = plan?.slug ?? null;
      const inPlan = plan ? resolvePlanFeatures(plan) : [];
      const effective = effectiveFeaturesFromList(inPlan, overridesByTenant.get(t.id) ?? []);
      const used = usedFeaturesOf(t.id);
      const u = units.get(t.id) ?? 0;
      const f = facilities.get(t.id) ?? 0;
      const usr = (users.get(t.id) ?? 0) + (invites.get(t.id) ?? 0);
      const extra = addonsByTenant.get(t.id) ?? { monthly: 0, units: 0, facilities: 0, users: 0 };
      const maxUnits = plus(plan?.maxUnits ?? null, extra.units);
      const maxFacilities = plus(plan?.maxFacilities ?? null, extra.facilities);
      const maxUsers = plus(plan?.maxUsers ?? null, extra.users);

      const features = TenantFeatures.map((ft) => ({
        feature: ft,
        label: FEATURE_LABELS[ft],
        inPlan: inPlan.includes(ft),
        viaOverride: !inPlan.includes(ft) && effective.includes(ft),
        used: used.has(ft),
      }));
      // Fuera de plan = la usa sin tenerla contratada de ninguna forma.
      const usesFeatureOutsidePlan = [...used].some((ft) => !effective.includes(ft));
      const tapsLimit =
        (maxUnits !== null && u >= maxUnits) ||
        (maxFacilities !== null && f >= maxFacilities) ||
        (maxUsers !== null && usr >= maxUsers);

      const currentPrice = plan ? Number(plan.priceMonthly) : 0;
      const monthlyPaid = currentPrice + extra.monthly;
      const recommended = sortedPlans.find((p) => planCovers(p, used, u, f, usr, extra)) ?? null;
      const recommendedPrice = recommended ? Number(recommended.priceMonthly) : null;
      // Candidato si el plan recomendado es más caro que el suyo y lo necesita
      // (usa algo que no tiene o topa un límite) o no le cuesta más que lo que ya
      // paga con los extras. Quien paga a gusto plan + extras no es candidato.
      const isCandidate =
        recommendedPrice !== null &&
        recommendedPrice > currentPrice &&
        (usesFeatureOutsidePlan || tapsLimit || recommendedPrice <= monthlyPaid);

      return {
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        planSlug,
        planName: plan?.name ?? null,
        features,
        usage: { units: u, maxUnits, facilities: f, maxFacilities, users: usr, maxUsers },
        monthlyPaid: Math.round(monthlyPaid * 100) / 100,
        recommendedPlanPrice: isCandidate ? recommendedPrice : null,
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
      tenantsWithAccess: tenantDtos.filter((t) => {
        const f = t.features.find((x) => x.feature === ft);
        return f?.inPlan || f?.viaOverride;
      }).length,
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
        where: { tenantId, deletedAt: null, status: { in: ACCOUNTING_STATUSES }, kind: 'invoice' },
        _sum: { total: true },
        _count: true,
      }),
      this.admin.invoice.aggregate({
        where: { tenantId, deletedAt: null, status: { in: ['issued', 'overdue'] } },
        _sum: { total: true, amountPaid: true, amountRefunded: true },
      }),
      this.admin.invoice.count({ where: { tenantId, deletedAt: null, status: 'overdue' } }),
      this.admin.payment.aggregate({
        where: {
          tenantId,
          status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
          invoice: { kind: 'invoice' },
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] }, // una compensación con abono no es dinero cobrado
        },
        _sum: { amount: true, refundedAmount: true },
      }),
      this.admin.invoice.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ACCOUNTING_STATUSES },
          kind: 'invoice',
          issueDate: { gte: fromDate, lt: toExclusive },
        },
        select: { issueDate: true, total: true },
      }),
      this.admin.payment.findMany({
        where: {
          tenantId,
          status: { in: ['succeeded', 'partially_refunded', 'refunded'] }, // neto de reembolsos
          paidAt: { gte: fromDate, lt: toExclusive },
          invoice: { kind: 'invoice' },
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] }, // una compensación con abono no es dinero cobrado
        },
        select: { paidAt: true, amount: true, refundedAmount: true },
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
      collectedByKey.set(
        key,
        (collectedByKey.get(key) ?? 0) + Number(p.amount) - Number(p.refundedAmount),
      );
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
      totalCollected: round2(
        Number(collected._sum.amount ?? 0) - Number(collected._sum.refundedAmount ?? 0),
      ),
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
      data: {
        status: 'suspended',
        canceledAt: new Date(),
        ...(meta.churnReason ? { churnReason: meta.churnReason } : {}),
      },
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

  async reactivate(
    tenantId: string,
    meta: ActionMeta & { forgivePeriod?: boolean | undefined },
  ): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (tenant.status !== 'suspended') {
      // Idempotente: si ya esta activo o en trial no hacemos nada.
      return this.detail(tenantId);
    }
    // «Perdonar este periodo»: la suscripción impagada vuelve a estar al día y
    // su fin se mueve un mes (no se le cobra ese periodo). Con Stripe no: el
    // periodo lo lleva Stripe y seguiría reclamando la factura.
    let forgiven: { previousEnd: string; newEnd: string } | null = null;
    if (meta.forgivePeriod) {
      const sub = await this.admin.tenantSubscription.findUnique({ where: { tenantId } });
      if (sub?.status === 'past_due') {
        if (sub.stripeSubscriptionId && sub.billingMode === 'stripe') {
          throw new BadRequestException({
            code: 'forgive_not_on_stripe',
            message:
              'Paga por Stripe: perdona la factura desde Stripe o pásalo antes a pago manual.',
          });
        }
        const next = new Date(sub.currentPeriodEnd);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const newEnd = next.getTime() > Date.now() ? next : new Date(Date.now() + 30 * 86_400_000);
        await this.admin.tenantSubscription.update({
          where: { tenantId },
          data: { status: 'active', currentPeriodEnd: newEnd },
        });
        forgiven = {
          previousEnd: sub.currentPeriodEnd.toISOString(),
          newEnd: newEnd.toISOString(),
        };
      }
    }
    // Determinar status destino: si el trial sigue vigente, vuelve a trial;
    // si no, pasa a active.
    const targetStatus =
      tenant.trialEndsAt && tenant.trialEndsAt.getTime() > Date.now() ? 'trial' : 'active';

    await this.admin.tenant.update({
      where: { id: tenantId },
      // El tenant vuelve: deja de ser churn (se limpia motivo + fecha de baja).
      data: { status: targetStatus, churnReason: null, canceledAt: null },
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
      changes: {
        reason: meta.reason,
        newStatus: targetStatus,
        ...(forgiven ? { forgivenPeriod: forgiven } : {}),
      },
    });
    return this.detail(tenantId);
  }

  /**
   * Finaliza el periodo de prueba de un tenant y lo pasa a `active` sin esperar
   * a un pago (cortesía, o cliente que paga por fuera del sistema). Solo actúa
   * si está en `trial`; limpia `trialEndsAt` para que no reaparezca en «Trials
   * por expirar». Nota: lo normal es que el trial se cierre SOLO al pagar
   * (Stripe o pago manual ya llevan el tenant a `active`); esto es la palanca
   * manual para forzarlo.
   */
  /**
   * Marca/desmarca un tenant como EXENTO de facturación (cuenta interna del
   * dueño del SaaS, demo, partner o cortesía). Al marcarlo, se asegura de que
   * quede operativo (`active`, sin fecha de fin de trial); conserva su plan. Las
   * cuentas exentas quedan fuera de todas las métricas de negocio.
   */
  async setBillingExempt(
    tenantId: string,
    exempt: boolean,
    meta: ActionMeta,
  ): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    await this.admin.tenant.update({
      where: { id: tenantId },
      // Al eximir, dejarlo activo y sin trial (no debe expirar ni entrar en dunning).
      data: exempt
        ? {
            billingExempt: true,
            status: 'active',
            trialEndsAt: null,
            // Si estaba suspendido, deja de contar como baja.
            ...(tenant.status === 'suspended' ? { churnReason: null, canceledAt: null } : {}),
          }
        : { billingExempt: false },
    });
    // La suscripción también: si estaba en prueba o impagada, su panel seguía
    // mostrando «En prueba» / «Pago pendiente» aunque ya no paga.
    if (exempt) {
      await this.admin.tenantSubscription.updateMany({
        where: { tenantId, status: { in: ['trial', 'past_due', 'expired', 'cancelled'] } },
        data: { status: 'active', cancelAtPeriodEnd: false },
      });
    }
    await this.audit.write({
      tenantId,
      userId: null,
      action: exempt ? 'admin.tenant.billing_exempted' : 'admin.tenant.billing_unexempted',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: meta.superAdminId, reason: meta.reason },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: exempt ? 'admin.tenant.billing_exempted' : 'admin.tenant.billing_unexempted',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { reason: meta.reason },
    });
    return this.detail(tenantId);
  }

  async endTrial(tenantId: string, meta: ActionMeta): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (tenant.status !== 'trial') {
      throw new BadRequestException({
        code: 'tenant_not_in_trial',
        message: 'El tenant no está en periodo de prueba.',
      });
    }
    // Un trial finalizado sin conversión baja al plan FREE (0 features premium):
    // el tenant sigue operando lo básico gratis, pero no queda como "activo de
    // pago" en un plan que no ha pagado. Si ya hubiera pagado, el propio pago lo
    // habría pasado a `active` (no llegaría aquí en `trial`).
    const freePlan = await this.admin.subscriptionPlan.findFirst({ where: { slug: 'free' } });
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    if (freePlan) {
      // Baja la suscripción al plan free y la marca activa (sale de `trial`).
      await this.admin.tenantSubscription.updateMany({
        where: { tenantId },
        data: { planId: freePlan.id, status: 'active' },
      });
    }
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.trial_ended',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: meta.superAdminId, reason: meta.reason },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.trial_ended',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { reason: meta.reason },
    });
    return this.detail(tenantId);
  }

  async extendTrial(tenantId: string, args: ExtendTrialArgs): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    // Ampliar la prueba no es la forma de levantar una suspensión (se quedaría
    // con el motivo y la fecha de baja): primero hay que reactivarlo.
    if (tenant.status === 'suspended') {
      throw new BadRequestException({
        code: 'tenant_suspended',
        message: 'El tenant está suspendido: reactívalo antes de ampliarle la prueba.',
      });
    }
    const base =
      tenant.trialEndsAt && tenant.trialEndsAt.getTime() > Date.now()
        ? tenant.trialEndsAt
        : new Date();
    const newTrialEndsAt = new Date(base.getTime() + args.days * 24 * 60 * 60 * 1000);

    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        status: true,
        stripeSubscriptionId: true,
        plan: { select: { slug: true, priceMonthly: true } },
      },
    });
    // Un tenant que ya paga no vuelve a prueba (perdería su estado de cliente
    // de pago y saldría en «pruebas por expirar»).
    const onFree = !sub || sub.plan.slug === 'free';
    const paying =
      tenant.status !== 'trial' &&
      sub?.status !== 'trial' &&
      (!!sub?.stripeSubscriptionId || (!onFree && Number(sub?.plan.priceMonthly ?? 0) > 0));
    if (paying) {
      throw new BadRequestException({
        code: 'tenant_has_paid_plan',
        message: 'Este tenant ya tiene un plan de pago; no se le puede ampliar la prueba.',
      });
    }

    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        trialEndsAt: newTrialEndsAt,
        ...(tenant.status === 'cancelled' ? {} : { status: 'trial' }),
      },
    });
    // Prueba ya vencida (pasó al plan Free): vuelve a probar con el plan de la
    // prueba, como al registrarse.
    if (onFree && sub && tenant.status !== 'cancelled') {
      const trialPlan = await this.admin.subscriptionPlan.findFirst({
        where: { slug: 'starter', isActive: true },
      });
      if (trialPlan) {
        await this.admin.tenantSubscription.update({
          where: { tenantId },
          data: { planId: trialPlan.id, status: 'trial', currentPeriodEnd: newTrialEndsAt },
        });
      }
    }
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
   * Extiende el trial de VARIOS tenants a la vez (palanca de retención por
   * lote). Reutiliza `extendTrial` por tenant; ignora los tenants inexistentes
   * o cancelados (solo cuenta los efectivamente actualizados). Devuelve cuántos
   * se movieron.
   */
  async extendTrialsBatch(
    tenantIds: string[],
    args: ExtendTrialArgs,
  ): Promise<{ updated: number }> {
    let updated = 0;
    // Solo los que están en prueba: el lote no devuelve a prueba a un tenant
    // activo en Free (eso se hace a propósito desde su ficha). Sin duplicados.
    const inTrial = await this.admin.tenant.findMany({
      where: { id: { in: [...new Set(tenantIds)] }, deletedAt: null, status: 'trial' },
      select: { id: true },
    });
    for (const { id: tenantId } of inTrial) {
      try {
        await this.extendTrial(tenantId, args);
        updated += 1;
      } catch (err) {
        // Tenant inexistente/ilegible: se salta sin abortar el lote.
        this.logger.warn(`extendTrialsBatch: no se pudo extender ${tenantId}: ${String(err)}`);
      }
    }
    return { updated };
  }

  /** Añade o quita etiquetas a varios tenants (acción masiva de la lista). */
  async bulkTags(
    input: { tenantIds: string[]; add: string[]; remove: string[] },
    meta: { superAdminId: string; ipAddress: string | null; userAgent: string | null },
  ): Promise<{ updated: number }> {
    const remove = new Set(input.remove);
    const rows = await this.admin.tenant.findMany({
      where: { id: { in: [...new Set(input.tenantIds)] }, deletedAt: null },
      select: { id: true, tags: true },
    });
    let updated = 0;
    for (const t of rows) {
      const next = [...new Set([...t.tags.filter((x) => !remove.has(x)), ...input.add])].slice(
        0,
        20,
      );
      if (next.length === t.tags.length && next.every((x, i) => x === t.tags[i])) continue;
      await this.admin.tenant.update({ where: { id: t.id }, data: { tags: next } });
      updated += 1;
    }
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenants.bulk_tagged',
      targetType: 'tenant',
      changes: { tenants: rows.length, updated, add: input.add, remove: input.remove },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return { updated };
  }

  /**
   * Cambia el plan de suscripcion de un tenant (super admin). Util para
   * mover un tenant entre planes (free/starter/pro) — controla, vía
   * `PLAN_FEATURES`, qué modulos premium ve. No toca Stripe (cambio manual).
   */
  /** Checklist de puesta a punto del tenant (derivado de sus datos). */
  async getOnboarding(tenantId: string): Promise<AdminOnboardingDto> {
    await this.findOrThrow(tenantId);
    const [
      tenant,
      ownerVerified,
      facilities,
      units,
      customers,
      contracts,
      aeat,
      series,
      issuedInvoices,
      activeUsers,
      redsys,
      gocardless,
      sepa,
    ] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: {
          portalLogoUrl: true,
          portalBrandColor: true,
          invoicingMode: true,
          transferIban: true,
        },
      }),
      this.admin.user.count({
        where: { tenantId, role: 'owner', emailVerifiedAt: { not: null } },
      }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.customer.count({ where: { tenantId, deletedAt: null } }),
      this.admin.contract.count({ where: { tenantId } }),
      this.admin.tenantAeatCredential.count({
        where: { tenantId, ownerId: null, revokedAt: null },
      }),
      this.admin.invoiceSeries.count({ where: { tenantId, isActive: true } }),
      this.admin.invoice.count({
        where: { tenantId, status: { notIn: ['draft', 'cancelled'] } },
      }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      this.admin.redsysSettings.count({ where: { tenantId, enabled: true } }),
      this.admin.goCardlessSettings.count({ where: { tenantId, enabled: true } }),
      this.admin.sepaSettings.count({ where: { tenantId, enabled: true } }),
    ]);
    const paymentsReady = redsys + gocardless + sepa > 0 || Boolean(tenant?.transferIban);
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
      { key: 'invoice_series', label: 'Serie de facturación creada', done: series > 0 },
      { key: 'first_invoice', label: 'Primera factura emitida', done: issuedInvoices > 0 },
      {
        key: 'payments',
        label: 'Forma de cobro configurada (Redsys, GoCardless, SEPA o IBAN)',
        done: paymentsReady,
      },
      // En modo Holded la factura la registra Holded: no necesita certificado propio.
      ...(tenant?.invoicingMode === 'holded'
        ? []
        : [{ key: 'verifactu', label: 'Veri*Factu (certificado AEAT)', done: aeat > 0 }]),
      { key: 'team', label: 'Equipo invitado (2 o más usuarios)', done: activeUsers > 1 },
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
        where: { tenantId, ...liveOverrideWhere() },
        select: {
          feature: true,
          enabled: true,
          source: true,
          expiresAt: true,
          trialAddon: { select: { name: true } },
        },
      }),
    ]);
    const planSlug = subscription?.plan.slug ?? null;
    const overrides = rows.map((r) => ({
      feature: r.feature as TenantFeature,
      enabled: r.enabled,
      source: (r.source === 'addon' || r.source === 'trial' ? r.source : 'manual') as
        | 'manual'
        | 'addon'
        | 'trial',
      expiresAt: r.expiresAt?.toISOString() ?? null,
      trialAddonName: r.trialAddon?.name ?? null,
    }));
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
    args: {
      overrides: {
        feature: TenantFeature;
        enabled: boolean;
        expiresAt?: string | null | undefined;
      }[];
    } & ActionMeta,
  ): Promise<AdminTenantFeaturesDto> {
    await this.findOrThrow(tenantId);
    const [subscription, managed] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      // Las de un extra contratado o en prueba las gestiona el motor de extras.
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId, source: { in: ['addon', 'trial'] } },
        select: { feature: true },
      }),
    ]);
    const planFeatures = new Set(subscription ? resolvePlanFeatures(subscription.plan) : []);
    const managedSet = new Set(managed.map((m) => m.feature));
    // Solo guardamos los overrides que cambian algo respecto al plan.
    const effectiveOverrides = args.overrides.filter(
      (o) => o.enabled !== planFeatures.has(o.feature) && !managedSet.has(o.feature),
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
                // Hasta el final de ese día (hora de Madrid).
                expiresAt: o.expiresAt ? zonedNextDayStart(o.expiresAt) : null,
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
        customDomainReadyAt: true,
        subscription: {
          select: { plan: { select: { slug: true, tenantFeatures: true } } },
        },
      },
      orderBy: [{ customDomainVerifiedAt: 'asc' }, { name: 'asc' }],
    });
    const overrides = await this.admin.tenantFeatureOverride.findMany({
      where: { tenantId: { in: tenants.map((t) => t.id) }, ...liveOverrideWhere() },
      select: { tenantId: true, feature: true, enabled: true },
    });
    const overridesBy = new Map<string, { feature: TenantFeature; enabled: boolean }[]>();
    for (const o of overrides) {
      const list = overridesBy.get(o.tenantId) ?? [];
      list.push({ feature: o.feature as TenantFeature, enabled: o.enabled });
      overridesBy.set(o.tenantId, list);
    }
    return tenants.map((t) => ({
      tenantId: t.id,
      tenantName: t.name,
      tenantSlug: t.slug,
      customDomain: t.customDomain!,
      verifiedAt: t.customDomainVerifiedAt?.toISOString() ?? null,
      planSlug: t.subscription?.plan.slug ?? 'free',
      featureEnabled: effectiveFeaturesFromList(
        t.subscription ? resolvePlanFeatures(t.subscription.plan) : [],
        overridesBy.get(t.id) ?? [],
      ).includes('custom_domain'),
      dnsReadyAt: t.customDomainReadyAt?.toISOString() ?? null,
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
    const tenant = await this.findOrThrow(tenantId);
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
    // Cambiar de plan a un tenant EN TRIAL acaba el trial: pasa a `active` en el
    // plan elegido y limpia `trialEndsAt`. Sincroniza los DOS estados que de otro
    // modo quedan desalineados (`tenant.status` —el badge principal— y
    // `subscription.status`): sin esto un tenant movido a "pro" seguía en
    // `status='trial'`, apareciendo en "trials por expirar", nurturing de trial,
    // etc. Para dar features de un plano superior DURANTE el trial se usan los
    // feature overrides, no el cambio de plan.
    const endsTrial = tenant.status === 'trial' || subscription.status === 'trial';
    // Paga por Stripe: el plan se cambia también en Stripe (con prorrateo, como
    // el cambio desde el panel del tenant). Si no, la app daba un plan y Stripe
    // seguía cobrando el otro. Si Stripe falla, no se cambia nada.
    const chargedByStripe =
      !!subscription.stripeSubscriptionId &&
      subscription.billingMode === 'stripe' &&
      !tenant.billingExempt &&
      plan.id !== subscription.planId;
    if (chargedByStripe) {
      await this.saasBilling.swapStripePlan({
        tenantId,
        stripeSubscriptionId: subscription.stripeSubscriptionId!,
        currentPlanId: subscription.planId,
        plan,
        billingCycle: 'current',
      });
    }
    await this.admin.tenantSubscription.update({
      where: { tenantId },
      data: {
        planId: plan.id,
        ...(subscription.status === 'trial' ? { status: 'active' as const } : {}),
      },
    });
    if (tenant.status === 'trial') {
      await this.admin.tenant.update({
        where: { id: tenantId },
        data: { status: 'active', trialEndsAt: null },
      });
    }
    const changes = {
      reason: args.reason,
      previousPlan: previousSlug,
      newPlan: plan.slug,
      ...(endsTrial ? { endedTrial: true } : {}),
      ...(chargedByStripe ? { stripeUpdated: true } : {}),
    };
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
    if (!planSlug) {
      throw new BadRequestException({ code: 'plan_required', message: 'Indica el plan' });
    }
    await this.findOrThrow(tenantId);
    const [newPlan, subscription, units, facilities, users, invites, addons] = await Promise.all([
      this.admin.subscriptionPlan.findUnique({ where: { slug: planSlug } }),
      this.admin.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } }),
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      // Como el límite real: usuarios activos + invitaciones pendientes.
      this.admin.invitation.count({
        where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
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
    check('users', users + invites, newPlan.maxUsers);

    const currentPrice = Number(subscription.plan.priceMonthly);
    const newPrice = Number(newPlan.priceMonthly);
    const chargedByStripe =
      !!subscription.stripeSubscriptionId && subscription.billingMode === 'stripe';
    return {
      chargedByStripe,
      stripePriceMissing: chargedByStripe && !newPlan.stripePriceId,
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
    const existing = await this.findOrThrow(tenantId);

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
          // Cierra las sesiones del área de clientes que siguieran abiertas.
          portalSessionVersion: { increment: 1 },
          referralCode: null,
          deletedAt: now,
        },
      });

      // Accesos: revocados y sin secreto, tarjeta ni cara (el PIN no debe abrir
      // nada y la foto es un dato biométrico). Lo mismo que el RGPD de un inquilino.
      const faces = await tx.accessCredential.findMany({
        where: { tenantId, facePhotoKey: { not: null } },
        select: { facePhotoKey: true },
      });
      await tx.accessCredential.updateMany({
        where: { tenantId },
        data: {
          status: 'revoked',
          revokedAt: now,
          secretHash: null,
          secretPreview: null,
          secretEncrypted: null,
          rfidUid: null,
          facePhotoKey: null,
          label: null,
          metadata: {},
        },
      });
      await tx.pushSubscription.deleteMany({ where: { tenantId } });
      // Lo que escribieron los inquilinos o se anotó sobre ellos.
      const chatFiles = await tx.customerMessage.findMany({
        where: { tenantId, attachmentKey: { not: null } },
        select: { attachmentKey: true },
      });
      await tx.customerMessage.updateMany({
        where: { tenantId },
        data: { body: ANON, attachmentKey: null, attachmentMime: null, attachmentName: null },
      });
      await tx.customerInteraction.updateMany({ where: { tenantId }, data: { content: ANON } });
      await tx.customerFollowup.updateMany({
        where: { tenantId },
        data: { title: ANON, note: null },
      });
      await tx.review.updateMany({
        where: { tenantId },
        data: { comment: null, ip: null, userAgent: null },
      });
      await tx.unitChangeRequest.updateMany({
        where: { tenantId },
        data: { note: ANON, resolutionNote: null },
      });
      await tx.unitRequest.updateMany({
        where: { tenantId },
        data: { note: ANON, resolutionNote: null },
      });
      await tx.waitlistEntry.updateMany({
        where: { tenantId },
        data: { contactName: ANON, contactEmail: ANON, contactPhone: null, notes: null },
      });
      const photos = await tx.contractInspectionPhoto.findMany({
        where: { tenantId },
        select: { key: true },
      });
      await tx.contractInspectionPhoto.deleteMany({ where: { tenantId } });
      // Mandatos SEPA de los inquilinos: de baja (se conservan como prueba de
      // los adeudos ya cobrados, como en el RGPD de un inquilino).
      await tx.sepaMandate.updateMany({
        where: { tenantId, status: 'active' },
        data: { status: 'cancelled' },
      });

      await tx.customerDocument.deleteMany({ where: { tenantId } });
      await tx.customerAuthorizedPerson.deleteMany({ where: { tenantId } });
      // Firmas y condiciones aceptadas: se conservan como prueba, sin IP,
      // navegador ni email de quien firmó.
      await tx.contractSignature.updateMany({
        where: { tenantId },
        data: { ipAddress: null, userAgent: null, signerEmail: null },
      });
      await tx.legalDocAcceptance.updateMany({
        where: { tenantId },
        data: { ipAddress: null, userAgent: null },
      });
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
          secretsEncrypted: null,
          errorMessage: null,
        },
      });

      // Claves y secretos del propio negocio: el certificado de la AEAT (con su
      // clave privada), las pasarelas, Holded, el acreedor SEPA, el dominio de
      // correo, las claves de API y los webhooks. Ya no se van a usar.
      await tx.tenantAeatCredential.deleteMany({ where: { tenantId } });
      await tx.redsysSettings.deleteMany({ where: { tenantId } });
      await tx.goCardlessSettings.deleteMany({ where: { tenantId } });
      await tx.holdedSettings.deleteMany({ where: { tenantId } });
      await tx.sepaSettings.deleteMany({ where: { tenantId } });
      await tx.tenantEmailDomain.deleteMany({ where: { tenantId } });
      await tx.apiKey.updateMany({
        where: { tenantId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.webhook.updateMany({
        where: { tenantId },
        data: { isActive: false, revokedAt: now, secret: '' },
      });
      // Propietarios: se conservan nombre y NIF (emiten facturas que hay que
      // guardar) sin su contacto ni su cuenta.
      await tx.owner.updateMany({
        where: { tenantId },
        data: { email: null, phone: null, ibanEncrypted: null, ibanLast4: null },
      });

      // WhatsApp: conversaciones sin texto ni números y fuera el token del número.
      const whatsapp = await anonymizeWhatsappConversations(tx, { tenantId });
      await tx.tenantWhatsappSettings.deleteMany({ where: { tenantId } });
      // Chat con IA de la web: lo que escribieron los visitantes.
      await tx.webChatConversation.deleteMany({ where: { tenantId } });
      // La cuenta de Stripe del tenant (la cuenta sigue en Stripe, a su nombre).
      await tx.tenantStripeAccount.deleteMany({ where: { tenantId } });
      // Instagram y Facebook: fuera el token de la página y lo descargado.
      await tx.socialPost.deleteMany({ where: { tenantId } });
      await tx.socialDailyMetric.deleteMany({ where: { tenantId } });
      await tx.tenantSocialAccount.deleteMany({ where: { tenantId } });

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
            appPinHash: null,
            isActive: false,
          },
        });
      }
      await tx.userPasskey.deleteMany({ where: { tenantId } });

      await tx.session.deleteMany({ where: { tenantId } });

      await tx.tenant.update({
        where: { id: tenantId },
        // La fecha de baja se conserva (o se pone ahora): las métricas de bajas
        // y de retención cuentan también a los tenants anonimizados.
        data: {
          status: 'cancelled',
          deletedAt: now,
          canceledAt: existing.canceledAt ?? now,
          billingEmail: null,
          taxId: null,
          contactEmail: null,
          contactPhone: null,
          transferIban: null,
        },
      });

      return {
        customers: customers.count,
        users: users.length,
        leads: leads.count,
        communications: communications.count,
        whatsappConversations: whatsapp.count,
        fileKeys: [
          ...whatsapp.mediaKeys,
          ...faces.map((f) => f.facePhotoKey!),
          ...photos.map((p) => p.key),
          ...chatFiles.map((m) => m.attachmentKey!),
        ],
      };
    });

    const changes = {
      reason: meta.reason,
      anonymizedCustomers: counts.customers,
      anonymizedUsers: counts.users,
      anonymizedLeads: counts.leads,
      anonymizedCommunications: counts.communications,
      anonymizedWhatsappConversations: counts.whatsappConversations,
    };
    await this.files.deleteObjects('uploads', counts.fileKeys);
    // Documentos de los inquilinos y adjuntos que quedaran sueltos (las facturas
    // y los contratos firmados se conservan, como en el RGPD de un inquilino).
    for (const prefix of ['customers', 'chat', 'collections']) {
      await this.files
        .deleteByPrefix('uploads', `${tenantId}/${prefix}/`)
        .catch((err: unknown) =>
          this.logger.warn(
            `anonymize: no se pudo borrar ${prefix}/ de ${tenantId}: ${String(err)}`,
          ),
        );
    }
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
    billingExempt: boolean;
    trialEndsAt: Date | null;
    billingEmail: string | null;
    country: string;
    currency: string;
    timezone: string;
    taxId: string | null;
    billingLegalName: string | null;
    billingAddress: string | null;
    billingCity: string | null;
    billingPostalCode: string | null;
    createdAt: Date;
    subscription: null | {
      status: string;
      currentPeriodEnd: Date | null;
      stripeSubscriptionId: string | null;
      billingMode: string;
      plan: { slug: string; name: string } | null;
    };
    _count: { users: number; customers: number; contracts: number; facilities: number };
  }): AdminTenantDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      billingExempt: row.billingExempt,
      trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
      billingEmail: row.billingEmail,
      country: row.country,
      currency: row.currency,
      timezone: row.timezone,
      taxId: row.taxId,
      billingLegalName: row.billingLegalName,
      billingAddress: row.billingAddress,
      billingCity: row.billingCity,
      billingPostalCode: row.billingPostalCode,
      billingMissing: missingFiscalData({
        name: row.billingLegalName ?? row.name,
        taxId: row.taxId,
        address: row.billingAddress,
        city: row.billingCity,
        postalCode: row.billingPostalCode,
        country: row.country,
      }),
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
            billingMode: row.subscription.billingMode,
          }
        : null,
    };
  }
}
