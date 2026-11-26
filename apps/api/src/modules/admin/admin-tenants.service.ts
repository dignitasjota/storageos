import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';
import {
  EXTRA_UNITS_ADDON_SLUG,
  extraUnitsFor,
  FEATURE_LABELS,
  TenantFeatures,
  effectiveFeaturesFromList,
  missingFiscalData,
  resolvePlanFeatures,
  WEB_CHAT_AI_FEATURE,
} from '@storageos/shared';

import { TtlCache } from '../../common/cache/ttl-cache';
import { reconcileCustomDomainPause } from '../../common/custom-domain-pause';
import { todayInTimezone, zonedNextDayStart } from '../../common/format';
import { attachmentKeysOf } from '../../common/message-attachments';
import {
  isPayingSubscription,
  listPriceWithoutVat,
  loadMrrContext,
  mrrFor,
} from '../../common/saas-metrics';
import { lastTeamActivityByTenant } from '../../common/team-activity';
import { liveOverrideWhere } from '../../common/tenant-features';
import { anonymizeWhatsappConversations } from '../../common/whatsapp-anonymize';
import { ALL_FACILITIES, LIVE_CONTRACT_WHERE } from '../analytics/analytics-scope';
import {
  collectedBetween,
  collectedWhere,
  currentYearMonth,
  invoicedAmount,
  INVOICED_SELECT,
  invoicedWhere,
  receivables,
  zonedMonthKey,
  zonedMonthStart,
} from '../analytics/business-metrics';
import { AuditService } from '../auth/audit.service';
import { billableUnits } from '../billing-saas/billable-units';
import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { addMonthsUtc, periodsOwed, subscriptionDueDate } from '../billing-saas/platform-due';
import { amountToCharge, platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { INTENSITY_UNITS, loadFeatureIntensity } from './adoption-intensity';
import { ADOPTION_SIGNALS, adoptionLimits, pickRecommendedPlan } from './adoption-rules';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { TenantHealthService } from './tenant-health.service';

import type { Prisma } from '@storageos/database';
import type {
  AdminAdoptionDto,
  AdminAtRiskDto,
  AtRiskKind,
  AdminAtRiskTenantDto,
  AdminFeatureAdoptionDto,
  AdminOnboardingDto,
  AdminTenantAdoptionDto,
  AdminTenantCustomerDto,
  AdminTenantCustomersPageDto,
  AdminTenantDto,
  AdminTenantFacilitiesPageDto,
  AdminTenantsListResponseDto,
  AdminTenantFacilityDto,
  AdminTenantFeaturesDto,
  AdminChangePlanPreviewDto,
  AdminHealthSegment,
  AdminTenantHealthDto,
  AdminTenantsHealthDto,
  AdminTenantInvoicingDto,
  AdminTenantNotesDto,
  UpdateTenantNotesInput,
  AdminTenantUnitDto,
  AdminTenantUserDto,
  AdminTrialDto,
  ExtendTrialsBatchResultDto,
  TenantFeature,
} from '@storageos/shared';

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

/** Inquilinos que lista el diálogo de la ficha (los más recientes). */
export const ADMIN_CUSTOMERS_LIMIT = 500;

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

/** Un tenant grande tarda más que el plazo por defecto de una transacción. */
const ANONYMIZE_TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 } as const;

/**
 * Carpetas de ficheros del tenant que se borran al anonimizar (las facturas y
 * los contratos firmados se conservan).
 */
const ANONYMIZE_FILE_PREFIXES = [
  'customers',
  'chat',
  'collections',
  'incidents',
  'support',
  'tasks',
  'reminders',
  'expenses',
  'cameras',
] as const;

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
  /** Caché de 60 s de la adopción (agregación cross-tenant). */
  private readonly adoptionCache = new TtlCache<AdminAdoptionDto>();

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly files: FilesService,
    private readonly saasBilling: BillingSaasService,
    private readonly health: TenantHealthService,
    private readonly prisma: PrismaService,
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
        // Lo mismo que listan los diálogos: usuarios activos, inquilinos sin
        // borrar ni el de prueba, contratos vigentes y locales sin borrar.
        _count: {
          select: {
            users: { where: { isActive: true } },
            customers: { where: { deletedAt: null, isTest: false } },
            contracts: { where: LIVE_CONTRACT_WHERE },
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
        // Lo mismo que listan los diálogos: usuarios activos, inquilinos sin
        // borrar ni el de prueba, contratos vigentes y locales sin borrar.
        _count: {
          select: {
            users: { where: { isActive: true } },
            customers: { where: { deletedAt: null, isTest: false } },
            contracts: { where: LIVE_CONTRACT_WHERE },
            facilities: { where: { deletedAt: null } },
          },
        },
      },
    });
    // Un tenant anonimizado se sigue viendo (lo que queda: historial y pagos).
    if (!row) {
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
   * - pruebas que terminan en ≤7 días (y las ya vencidas que el cron aún no ha
   *   cerrado),
   * - suscripciones con pago fallido (`past_due`),
   * - clientes de pago sin actividad del equipo en 14+ días (con más de 14
   *   días de alta),
   * - pruebas caducadas sin pagar (en solo lectura),
   * - salud baja que no sale arriba.
   *
   * «Ignorar» oculta al tenant solo en la sección en la que se ignoró (los
   * antiguos, sin sección guardada, en todas). `applySnooze: false` (el «Hoy»,
   * que tiene su propio «apartar») no lo tiene en cuenta.
   */
  async getAtRisk(opts: { applySnooze?: boolean } = {}): Promise<AdminAtRiskDto> {
    const applySnooze = opts.applySnooze ?? true;
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const inactiveCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const planInclude = { subscription: { include: { plan: { select: { name: true } } } } };
    const live = { deletedAt: null, billingExempt: false } as const;

    const [trials, pastDue, payingTenants, expiredTrials, snoozedRows, health] = await Promise.all([
      this.admin.tenant.findMany({
        where: { ...live, status: 'trial', trialEndsAt: { lte: in7d } },
        include: planInclude,
        orderBy: { trialEndsAt: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: {
          ...live,
          status: { not: 'cancelled' },
          subscription: { status: 'past_due' },
        },
        include: {
          subscription: { include: { plan: { select: { name: true, priceMonthly: true } } } },
          subscriptionAddons: {
            where: { suspendedAt: null },
            select: { priceMonthly: true, quantity: true, billingMode: true },
          },
        },
        orderBy: { name: 'asc' },
      }),
      // Inactivos: solo los que pagan (como «Hoy») y con más de 14 días de alta.
      this.admin.tenant.findMany({
        where: {
          ...live,
          status: 'active',
          createdAt: { lt: inactiveCutoff },
          subscription: { status: 'active', plan: { priceMonthly: { gt: 0 } } },
        },
        include: planInclude,
        orderBy: { name: 'asc' },
      }),
      // Pruebas caducadas sin pagar: activos en solo lectura.
      this.admin.tenant.findMany({
        where: { ...live, status: 'active', subscription: { status: 'expired' } },
        include: planInclude,
        orderBy: { name: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: { ...live, riskSnoozedUntil: { gt: now } },
        select: {
          id: true,
          name: true,
          riskSnoozedUntil: true,
          riskSnoozedKind: true,
          riskSnoozeReason: true,
        },
        orderBy: { riskSnoozedUntil: 'asc' },
      }),
      this.getTenantsHealth(),
    ]);

    // Ignorado en esa sección (o en todas, los antiguos sin sección).
    const hidden = (kind: AtRiskKind, id: string): boolean =>
      applySnooze &&
      snoozedRows.some(
        (r) => r.id === id && (r.riskSnoozedKind === null || r.riskSnoozedKind === kind),
      );

    // Último uso real del equipo (inicio de sesión o sesión renovada), acotado
    // a los clientes de pago ya cargados.
    const lastLoginByTenant = await lastTeamActivityByTenant(
      this.admin,
      payingTenants.map((t) => t.id),
    );

    const toDto = (
      t: {
        id: string;
        name: string;
        slug: string;
        status: string;
        subscription: { plan: { name: string } | null } | null;
      },
      reason: AtRiskKind,
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

    // Una prueba ya vencida que el cron aún no ha cerrado sigue aquí, marcada.
    const trialExpiring = trials
      .filter((t) => !hidden('trial_expiring', t.id))
      .map((t) => {
        const expired = !!t.trialEndsAt && t.trialEndsAt.getTime() < now.getTime();
        const dto = toDto(
          t,
          'trial_expiring',
          t.trialEndsAt,
          expired ? 'La prueba ya venció y aún no se ha cerrado' : 'La prueba termina pronto',
        );
        return expired ? { ...dto, expired: true } : dto;
      });
    // Lo que debe de verdad: una cuota por periodo vencido (con los extras que
    // van en el mismo cargo, como en Cobros pendientes).
    const pastDueRows = pastDue.filter((t) => !hidden('past_due', t.id));
    const pricing = pastDueRows.length ? await platformPricing(this.admin) : null;
    const pastDueList = pastDueRows.map((t) => {
      const sub = t.subscription;
      if (!sub || !pricing) {
        return toDto(t, 'past_due', null, 'La cuota no se ha podido cobrar');
      }
      const withPlan = sub.billingMode === 'sepa' || sub.billingMode === 'redsys';
      const addons = withPlan
        ? t.subscriptionAddons
            .filter((a) => a.billingMode !== 'stripe')
            .reduce((sum, a) => sum + Number(a.priceMonthly) * a.quantity, 0)
        : 0;
      const perPeriod = amountToCharge(Number(sub.plan.priceMonthly) + addons, pricing);
      const since = subscriptionDueDate(sub);
      const periods = periodsOwed(
        since,
        now,
        1,
        sub.billingMode === 'stripe' && !!sub.stripeSubscriptionId,
      );
      const owed = Math.round(perPeriod * periods * 100) / 100;
      const dto = toDto(
        t,
        'past_due',
        since,
        `Debe ${owed.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}${
          periods > 1 ? ` (${periods} cuotas)` : ''
        }`,
      );
      return { ...dto, owedAmount: owed, owedPeriods: periods };
    });
    const idle = payingTenants.filter((t) => {
      const last = lastLoginByTenant.get(t.id) ?? null;
      return !last || last < inactiveCutoff;
    });
    const inactive = idle
      .filter((t) => !hidden('inactive', t.id))
      .map((t) => {
        const last = lastLoginByTenant.get(t.id) ?? null;
        return toDto(
          t,
          'inactive',
          last,
          last ? 'Paga y nadie entra desde hace 14 días o más' : 'Paga y nadie ha entrado nunca',
        );
      });
    const trialExpired = expiredTrials
      .filter((t) => !hidden('trial_expired', t.id))
      .map((t) =>
        toDto(
          t,
          'trial_expired',
          t.trialEndedAt ?? t.trialEndsAt,
          'La prueba terminó sin pagar: está en solo lectura',
        ),
      );

    // Salud «en riesgo» o «dormida» que no sale ya arriba: el mismo criterio que
    // la página de Salud, para que las dos listas no se contradigan. Fuera los
    // exentos, los borrados y las altas de menos de 14 días (aún no han tenido
    // tiempo de entrar: el mismo margen que «Inactivos»).
    // (Lo ignorado en otra sección tampoco cae aquí.)
    const listed = new Set([...trials, ...pastDue, ...idle, ...expiredTrials].map((t) => t.id));
    const excluded = new Set(
      (
        await this.admin.tenant.findMany({
          where: {
            OR: [
              { billingExempt: true },
              { deletedAt: { not: null } },
              { createdAt: { gte: inactiveCutoff } },
            ],
          },
          select: { id: true },
        })
      ).map((t) => t.id),
    );
    const lowHealth: AdminAtRiskTenantDto[] = health
      .filter(
        (h) =>
          // Clientes (las pruebas tienen su activación y su propia lista).
          (h.segment === 'paying' || h.segment === 'unpaid') &&
          (h.level === 'at_risk' || h.level === 'dormant') &&
          !listed.has(h.tenantId) &&
          !excluded.has(h.tenantId) &&
          !hidden('low_health', h.tenantId),
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
          [...h.factors].filter((f) => f.counted).sort((a, b) => a.score - b.score)[0]?.detail ?? ''
        }`,
      }));

    // Último playbook de retención (14 días): la fila lo dice y el botón espera.
    const shown = [...trialExpiring, ...pastDueList, ...inactive, ...trialExpired, ...lowHealth];
    const playbooks = shown.length
      ? await this.admin.superAdminAuditLog.groupBy({
          by: ['targetTenantId'],
          where: {
            action: 'admin.tenant.retention_playbook',
            targetTenantId: { in: [...new Set(shown.map((t) => t.id))] },
            occurredAt: { gte: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000) },
          },
          _max: { occurredAt: true },
        })
      : [];
    const playbookBy = new Map(
      playbooks.map((p) => [p.targetTenantId, p._max.occurredAt?.toISOString() ?? null]),
    );
    const withPlaybook = (rows: AdminAtRiskTenantDto[]): AdminAtRiskTenantDto[] =>
      rows.map((r) => {
        const at = playbookBy.get(r.id);
        return at ? { ...r, playbookAt: at } : r;
      });

    return {
      trialExpiring: withPlaybook(trialExpiring),
      pastDue: withPlaybook(pastDueList),
      inactive: withPlaybook(inactive),
      lowHealth: withPlaybook(lowHealth),
      trialExpired: withPlaybook(trialExpired),
      snoozedCount: snoozedRows.length,
      snoozed: snoozedRows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.riskSnoozedKind,
        until: r.riskSnoozedUntil!.toISOString(),
        reason: r.riskSnoozeReason,
      })),
    };
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
    const [loginMap, facilities, units, contracts] = await Promise.all([
      lastTeamActivityByTenant(this.admin, ids),
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
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const facBy = count(facilities);
    const unitBy = count(units);
    const contractBy = count(contracts);
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Días naturales en hora de España: «vence hoy» es 0 aunque queden horas.
    const today = todayInTimezone('Europe/Madrid', now).getTime();
    return trials.map((t) => {
      const last = loginMap.get(t.id) ?? null;
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        planName: t.subscription?.plan?.name ?? null,
        trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
        daysLeft: t.trialEndsAt
          ? Math.round((todayInTimezone('Europe/Madrid', t.trialEndsAt).getTime() - today) / DAY_MS)
          : null,
        expired: !!t.trialEndsAt && t.trialEndsAt.getTime() < now.getTime(),
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

  // --- Salud por tenant ---------------------------------------------------

  /**
   * Salud de todos los tenants vivos (clientes con su salud y pruebas con su
   * activación; cada uno con su `segment`). La calcula `TenantHealthService`.
   */
  getTenantsHealth(): Promise<AdminTenantHealthDto[]> {
    return this.health.all();
  }

  /** Los tenants de un grupo de Salud, con el recuento de cada grupo. */
  getTenantsHealthBySegment(segment?: AdminHealthSegment): Promise<AdminTenantsHealthDto> {
    return this.health.list(segment);
  }

  /** Puntuación de un tenant concreto (404 si no existe). */
  getTenantHealth(tenantId: string): Promise<AdminTenantHealthDto> {
    return this.health.one(tenantId);
  }

  // --- Adopción de funciones y venta ---------------------------------------

  /**
   * Por cada tenant vivo (sin las exentas): qué funciones usa de verdad (en los
   * últimos 90 días donde hay fecha; si no, configuración activa, ver
   * `ADOPTION_SIGNALS`), uso frente a los límites del plan y si es candidato a
   * subir de plan. El **plan recomendado** es el público y activo más barato
   * que cubre sus funciones en uso y sus límites **con margen** (trasteros al
   * 80 % como mucho; locales y usuarios con hueco para uno más si ya están en
   * el límite). Es candidato si ese plan es más caro que el suyo y lo necesita
   * (usa algo que no tiene o topa un límite) o no le cuesta más de lo que ya
   * paga con los extras. Solo lectura.
   */
  getAdoption(): Promise<AdminAdoptionDto> {
    return this.adoptionCache.get('all', () => this.computeAdoption(null));
  }

  /** Adopción de un solo tenant (para su ficha de negocio). null si no sale. */
  async getAdoptionForTenant(tenantId: string): Promise<AdminTenantAdoptionDto | null> {
    const r = await this.computeAdoption(tenantId);
    return r.tenants[0] ?? null;
  }

  private async computeAdoption(tenantId: string | null): Promise<AdminAdoptionDto> {
    const now = new Date();
    const since90d = new Date(now.getTime() - 90 * 86_400_000);
    const scope: { tenantId?: string } = tenantId ? { tenantId } : {};
    const recent = { gte: since90d };
    const liveContract: Prisma.ContractWhereInput = {
      ...scope,
      deletedAt: null,
      status: { in: ['active', 'ending'] },
    };
    const tenantWhere: Prisma.TenantWhereInput = {
      deletedAt: null,
      billingExempt: false,
      status: { in: ['active', 'trial'] },
      ...(tenantId ? { id: tenantId } : {}),
    };
    const g = <T extends { tenantId: string; _count: { _all: number } }>(rows: T[]) =>
      new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const [
      tenants,
      plans,
      pricing,
      aiRows,
      bankRows,
      rentRows,
      insuranceRows,
      facialRows,
      deviceRows,
      accessLogRows,
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
      cessionRows,
      contractRows,
      seoDomainRows,
    ] = await Promise.all([
      this.admin.tenant.findMany({
        where: tenantWhere,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          billingExempt: true,
          deletedAt: true,
          webTemplate: true,
          customDomainVerifiedAt: true,
          portalLogoKey: true,
          portalBrandColor: true,
          tags: true,
          salesRepId: true,
          salesRep: { select: { fullName: true } },
          subscription: {
            select: {
              status: true,
              billingMode: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              plan: true,
            },
          },
        },
      }),
      this.admin.subscriptionPlan.findMany({ where: { isActive: true } }),
      platformPricing(this.admin),
      // Consultas al asistente IA del panel y del área de clientes (no el chat
      // de la web ni el de WhatsApp, que son otras funciones).
      this.admin.aiUsageEvent.groupBy({
        by: ['tenantId'],
        where: {
          ...scope,
          countsAsQuery: true,
          createdAt: recent,
          feature: { notIn: [WEB_CHAT_AI_FEATURE, 'whatsapp', 'whatsapp_own'] },
        },
        _count: { _all: true },
      }),
      this.admin.bankStatement.groupBy({
        by: ['tenantId'],
        where: { ...scope, createdAt: recent },
        _count: { _all: true },
      }),
      this.admin.rentIncrease.groupBy({
        by: ['tenantId'],
        where: { ...scope, createdAt: recent },
        _count: { _all: true },
      }),
      // Contratos en vigor con seguro (no basta con tener planes creados).
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { ...liveContract, insurancePlanId: { not: null } },
        _count: { _all: true },
      }),
      this.admin.accessCredential.groupBy({
        by: ['tenantId'],
        where: { ...scope, method: 'face', status: 'active' },
        _count: { _all: true },
      }),
      this.admin.accessDevice.groupBy({
        by: ['tenantId'],
        where: { ...scope, isActive: true },
        _count: { _all: true },
      }),
      // Todo contrato firmado crea un PIN: las credenciales no dicen nada.
      // Cuenta si hay dispositivos o entradas registradas en 90 días.
      this.admin.accessLog.groupBy({
        by: ['tenantId'],
        where: { ...scope, occurredAt: recent },
        _count: { _all: true },
      }),
      this.admin.cameraDevice.groupBy({ by: ['tenantId'], where: scope, _count: { _all: true } }),
      this.admin.automationRun.groupBy({
        by: ['tenantId'],
        where: { ...scope, startedAt: recent },
        _count: { _all: true },
      }),
      this.admin.sepaRemittance.groupBy({
        by: ['tenantId'],
        where: { ...scope, createdAt: recent },
        _count: { _all: true },
      }),
      this.admin.unit.groupBy({ by: ['tenantId'], where: scope, _count: { _all: true } }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null },
        _count: { _all: true },
      }),
      // Usuarios como los cuenta el límite del plan: activos + invitaciones pendientes.
      this.admin.user.groupBy({
        by: ['tenantId'],
        where: { ...scope, isActive: true },
        _count: { _all: true },
      }),
      this.admin.delinquencyCase.groupBy({
        by: ['tenantId'],
        where: { ...scope, OR: [{ createdAt: recent }, { closedAt: null }] },
        _count: { _all: true },
      }),
      this.admin.blogPost.groupBy({
        by: ['tenantId'],
        where: { ...scope, publishedAt: recent },
        _count: { _all: true },
      }),
      // Contratos en vigor sobre viviendas.
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: { ...liveContract, unit: { unitType: { propertyKind: 'housing' } } },
        _count: { _all: true },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ...scope, ownerId: { not: null }, deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { ...scope, ...liveOverrideWhere(now) },
        select: { tenantId: true, feature: true, enabled: true },
      }),
      this.admin.whatsappMessage.groupBy({
        by: ['tenantId'],
        where: { ...scope, createdAt: recent },
        _count: { _all: true },
      }),
      this.admin.webAreaPage.groupBy({
        by: ['tenantId'],
        where: { ...scope, isPublished: true },
        _count: { _all: true },
      }),
      this.admin.businessReminder.groupBy({
        by: ['tenantId'],
        where: { ...scope, status: { in: ['active', 'paused'] } },
        _count: { _all: true },
      }),
      this.admin.invitation.groupBy({
        by: ['tenantId'],
        where: { ...scope, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        _count: { _all: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { ...scope, suspendedAt: null },
        select: {
          tenantId: true,
          priceMonthly: true,
          addon: {
            select: {
              grantsUnits: true,
              grantsFacilities: true,
              grantsUsers: true,
              feature: true,
              name: true,
            },
          },
          quantity: true,
        },
      }),
      this.admin.unitCession.groupBy({
        by: ['tenantId'],
        where: { ...scope, OR: [{ createdAt: recent }, { endedAt: null }] },
        _count: { _all: true },
      }),
      this.admin.contract.groupBy({
        by: ['tenantId'],
        where: liveContract,
        _count: { _all: true },
      }),
      // SEO Avanzado: proyecto con algún dominio conectado a Search Console.
      this.admin.seoProjectDomain.groupBy({
        by: ['tenantId'],
        where: {
          ...(tenantId ? { tenantId } : { tenantId: { not: null } }),
          connectionStatus: 'connected',
        },
        _count: { _all: true },
      }),
    ]);

    const ai = g(aiRows);
    const bank = g(bankRows);
    const rent = g(rentRows);
    const insurance = g(insuranceRows);
    const facial = g(facialRows);
    const devices = g(deviceRows);
    const accessLogs = g(accessLogRows);
    const cameras = g(cameraRows);
    const automations = g(automationRows);
    const sepa = g(sepaRows);
    const units = g(unitRows);
    const facilities = g(facilityRows);
    const users = g(userRows);
    const collections = g(collectionsRows);
    const blogPosts = g(blogRows);
    const housing = g(housingRows);
    const ownedFacilities = g(ownerRows);
    const whatsapp = g(whatsappRows);
    const areaPages = g(areaPageRows);
    const reminders = g(reminderRows);
    const cessions = g(cessionRows);
    const seoDomains = new Map(
      seoDomainRows.flatMap((r) => (r.tenantId ? [[r.tenantId, r._count._all] as const] : [])),
    );
    const invites = g(inviteRows);
    const contracts = g(contractRows);
    // Capacidad que añaden los extras que ya tiene (sigue sumando con otro plan).
    const extraBy = new Map<string, { units: number; facilities: number; users: number }>();
    for (const a of addonRows) {
      const e = extraBy.get(a.tenantId) ?? { units: 0, facilities: 0, users: 0 };
      e.units += (a.addon.grantsUnits ?? 0) * a.quantity;
      e.facilities += (a.addon.grantsFacilities ?? 0) * a.quantity;
      e.users += (a.addon.grantsUsers ?? 0) * a.quantity;
      extraBy.set(a.tenantId, e);
    }
    const plus = (max: number | null, extra: number): number | null =>
      max === null ? null : max + extra;
    const overridesByTenant = new Map<string, { feature: TenantFeature; enabled: boolean }[]>();
    for (const o of overrideRows) {
      const list = overridesByTenant.get(o.tenantId) ?? [];
      list.push({ feature: o.feature as TenantFeature, enabled: o.enabled });
      overridesByTenant.set(o.tenantId, list);
    }
    const [mrrCtx, intensity] = await Promise.all([
      loadMrrContext(
        this.admin,
        tenants.map((t) => t.id),
      ),
      loadFeatureIntensity(this.admin, tenantId ? [tenantId] : null, now),
    ]);
    // Extras con función que paga cada tenant (para «paga y no usa»).
    const paidFeatureAddons = new Map<
      string,
      { feature: TenantFeature; addonName: string; monthly: number }[]
    >();
    for (const a of addonRows) {
      if (!a.addon.feature) continue;
      const list = paidFeatureAddons.get(a.tenantId) ?? [];
      list.push({
        feature: a.addon.feature as TenantFeature,
        addonName: a.addon.name,
        monthly: Number(a.priceMonthly) * a.quantity,
      });
      paidFeatureAddons.set(a.tenantId, list);
    }

    /** Funciones que el tenant usa de verdad (`ADOPTION_SIGNALS`). */
    const usedFeaturesOf = (
      t: (typeof tenants)[number],
      effective: TenantFeature[],
    ): Set<TenantFeature> => {
      const id = t.id;
      const s = new Set<TenantFeature>();
      const has = (m: Map<string, number>) => (m.get(id) ?? 0) > 0;
      if (has(ai)) s.add('ai_assistant');
      if (has(sepa)) s.add('sepa');
      if (has(bank)) s.add('bank_reconciliation');
      if (has(rent)) s.add('rent_increases');
      if (has(insurance)) s.add('insurance');
      if (has(devices) || has(accessLogs)) s.add('access_control');
      if (has(cameras)) s.add('cameras');
      if (has(facial)) s.add('facial_access');
      if (has(automations)) s.add('automations');
      if (has(collections)) s.add('collections');
      if (t.customDomainVerifiedAt) s.add('custom_domain');
      if (t.webTemplate !== 'default' || has(blogPosts)) s.add('web_premium');
      if (has(housing)) s.add('housing');
      if (has(ownedFacilities)) s.add('multi_owner');
      if (has(whatsapp)) s.add('whatsapp_business');
      if (has(areaPages)) s.add('local_seo');
      if (has(reminders)) s.add('business_reminders');
      if (has(cessions)) s.add('unit_cession');
      if (has(seoDomains)) s.add('seo_advanced');
      // El panel con su marca solo se ve con la función activa y una marca puesta.
      if (effective.includes('branded_panel') && (t.portalLogoKey || t.portalBrandColor)) {
        s.add('branded_panel');
      }
      return s;
    };

    // Solo se recomiendan planes públicos y activos (nunca uno oculto o a
    // medida), del más barato al más caro.
    const recommendable = plans
      .filter((p) => p.isPublic)
      .sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly));
    // Las funciones que no entran en ningún plan (solo se venden como extra) no
    // cuentan para recomendar plan: ninguno las cubre y el tenant nunca saldría.
    const sellableInPlans = new Set(recommendable.flatMap((p) => resolvePlanFeatures(p)));
    const netList = (price: number) => round2(listPriceWithoutVat(price, pricing));

    const tenantDtos: AdminTenantAdoptionDto[] = tenants.map((t) => {
      const sub = t.subscription;
      const plan = sub?.plan ?? null;
      const inTrial = t.status === 'trial';
      const inPlan = plan ? resolvePlanFeatures(plan) : [];
      const effective = effectiveFeaturesFromList(inPlan, overridesByTenant.get(t.id) ?? []);
      const used = usedFeaturesOf(t, effective);
      const u = units.get(t.id) ?? 0;
      const f = facilities.get(t.id) ?? 0;
      const usr = (users.get(t.id) ?? 0) + (invites.get(t.id) ?? 0);
      const realUse = (contracts.get(t.id) ?? 0) > 0;
      const extra = extraBy.get(t.id) ?? { units: 0, facilities: 0, users: 0 };
      const maxUnits = plus(plan?.maxUnits ?? null, extra.units);
      const maxFacilities = plus(plan?.maxFacilities ?? null, extra.facilities);
      const maxUsers = plus(plan?.maxUsers ?? null, extra.users);

      const paidAddons = paidFeatureAddons.get(t.id) ?? [];
      const tenantIntensity = intensity.get(t.id) ?? {};
      const features = TenantFeatures.map((ft) => {
        const unit = INTENSITY_UNITS[ft];
        const i = tenantIntensity[ft];
        return {
          feature: ft,
          label: FEATURE_LABELS[ft],
          inPlan: inPlan.includes(ft),
          viaOverride: !inPlan.includes(ft) && effective.includes(ft),
          used: used.has(ft),
          uses30: unit ? (i?.d30 ?? 0) : null,
          uses90: unit ? (i?.d90 ?? 0) : null,
          paidAddon: paidAddons.some((a) => a.feature === ft),
        };
      });
      // Extras que paga y no usa (riesgo de que los dé de baja).
      const paidUnused = paidAddons
        .filter((a) => !used.has(a.feature))
        .map((a) => ({
          feature: a.feature,
          label: FEATURE_LABELS[a.feature] ?? a.feature,
          addonName: a.addonName,
          monthly: netList(a.monthly),
        }));
      // Fuera de plan = la usa sin tenerla contratada de ninguna forma.
      const usesFeatureOutsidePlan = [...used].some((ft) => !effective.includes(ft));
      const limits = adoptionLimits(
        { units: u, facilities: f, users: usr },
        { units: maxUnits, facilities: maxFacilities, users: maxUsers },
        { inTrial, realUse },
      );

      // Lo que aporta al mes sin IVA (como el MRR). En prueba no paga nada.
      const mrr = sub ? mrrFor(mrrCtx, t.id, sub).total : 0;
      const paying = isPayingSubscription(sub, t) && mrr > 0;
      const monthlyPaid = paying ? mrr : 0;
      const wouldPay = inTrial && mrr > 0 ? mrr : null;
      const currentPrice = plan ? netList(Number(plan.priceMonthly)) : 0;
      const recommended = pickRecommendedPlan(recommendable, {
        used,
        sellableInPlans,
        usage: { units: u, facilities: f, users: usr },
        extra,
        needsRoom: limits.atLimit,
      });
      const recommendedPrice = recommended ? netList(Number(recommended.priceMonthly)) : null;
      const isCandidate =
        recommendedPrice !== null &&
        recommended?.id !== plan?.id &&
        recommendedPrice > currentPrice &&
        (usesFeatureOutsidePlan ||
          limits.tapsLimit ||
          (monthlyPaid > 0 && recommendedPrice <= monthlyPaid));

      return {
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        planSlug: plan?.slug ?? null,
        planName: plan?.name ?? null,
        features,
        usage: { units: u, maxUnits, facilities: f, maxFacilities, users: usr, maxUsers },
        monthlyPaid: round2(monthlyPaid),
        inTrial,
        wouldPay: wouldPay !== null ? round2(wouldPay) : null,
        recommendedPlanPrice: isCandidate ? recommendedPrice : null,
        usesFeatureOutsidePlan,
        tapsLimit: limits.tapsLimit,
        nearLimit: limits.nearLimit,
        limitDetail: limits.detail,
        isCandidate,
        recommendedPlanSlug: isCandidate ? (recommended?.slug ?? null) : null,
        recommendedPlanName: isCandidate ? (recommended?.name ?? null) : null,
        status: t.status,
        tags: t.tags,
        salesRepId: t.salesRepId,
        salesRepName: t.salesRep?.fullName ?? null,
        paidUnused,
        paidUnusedMonthly: round2(paidUnused.reduce((a, x) => a + x.monthly, 0)),
      };
    });

    // Resumen de adopción por función.
    const featureAdoption: AdminFeatureAdoptionDto[] = TenantFeatures.map((ft) => ({
      feature: ft,
      label: FEATURE_LABELS[ft],
      signal: ADOPTION_SIGNALS[ft],
      tenantsUsing: tenantDtos.filter((t) => t.features.find((x) => x.feature === ft)?.used).length,
      tenantsWithAccess: tenantDtos.filter((t) => {
        const f = t.features.find((x) => x.feature === ft);
        return f?.inPlan || f?.viaOverride;
      }).length,
      uses30Total: INTENSITY_UNITS[ft]
        ? tenantDtos.reduce(
            (a, t) => a + (t.features.find((x) => x.feature === ft)?.uses30 ?? 0),
            0,
          )
        : null,
      intensityUnit: INTENSITY_UNITS[ft] ?? null,
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
      nearLimitCount: tenantDtos.filter((t) => t.nearLimit).length,
      paidUnusedCount: tenantDtos.filter((t) => t.paidUnused.length > 0).length,
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
    // Último acceso real: inicio de sesión o sesión renovada (la app instalada
    // mantiene la sesión 90 días sin volver a iniciarla).
    // Solo las sesiones renovadas: la que abre el inicio de sesión ya cuenta en
    // `lastLoginAt` (como `team-activity`).
    const sessions = await this.admin.session.groupBy({
      by: ['userId'],
      where: { tenantId, rotatedFromId: { not: null } },
      _max: { lastUsedAt: true },
    });
    const sessionBy = new Map(sessions.map((r) => [r.userId, r._max.lastUsedAt ?? null]));
    const lastAccess = (u: { id: string; lastLoginAt: Date | null }): Date | null => {
      const a = u.lastLoginAt;
      const b = sessionBy.get(u.id) ?? null;
      if (!a) return b;
      if (!b) return a;
      return a > b ? a : b;
    };
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
      lastLoginAt: lastAccess(u)?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  /**
   * Facturación del negocio del tenant (a sus inquilinos) con las mismas
   * definiciones que su Resumen (`business-metrics`): sin fianzas, la
   * sustitutiva solo por la diferencia, cobrado sin fianza aplicada ni
   * compensaciones, pendiente y vencido de facturas, y meses en su zona.
   */
  async getInvoicing(tenantId: string): Promise<AdminTenantInvoicingDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true, currency: true, timezone: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const tz = tenant.timezone || 'Europe/Madrid';
    const now = new Date();
    const { year, month } = currentYearMonth(tz, now);
    // Últimos 12 meses en su zona, del más antiguo al actual.
    const months = Array.from({ length: 12 }, (_, idx) => {
      const d = new Date(Date.UTC(year, month - 1 - (11 - idx), 1));
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() + 1;
      return {
        key: `${y}-${String(m).padStart(2, '0')}`,
        label: `${MONTHS_ES[m - 1]} ${String(y % 100).padStart(2, '0')}`,
        dayStart: d,
        zonedStart: zonedMonthStart(y, m, tz),
      };
    });
    const first = months[0]!;
    const farFuture = new Date(now.getTime() + 366 * 86_400_000);
    const epoch = new Date(0);

    const data = await this.prisma.withTenant(async (tx) => {
      const [all, window, collectedTotal, payments, owed] = await Promise.all([
        tx.invoice.findMany({
          where: invoicedWhere(ALL_FACILITIES, epoch, farFuture),
          select: INVOICED_SELECT,
        }),
        tx.invoice.findMany({
          where: invoicedWhere(ALL_FACILITIES, first.dayStart, farFuture),
          select: INVOICED_SELECT,
        }),
        collectedBetween(tx, ALL_FACILITIES, epoch, farFuture),
        tx.payment.findMany({
          where: collectedWhere(ALL_FACILITIES, first.zonedStart, farFuture),
          select: { paidAt: true, amount: true, refundedAmount: true },
        }),
        receivables(tx, ALL_FACILITIES, now),
      ]);
      return { all, window, collectedTotal, payments, owed };
    }, tenantId);

    const invoicedByKey = new Map<string, number>();
    for (const inv of data.window) {
      // `issueDate` es un día (DATE): su mes es el de la fecha.
      if (!inv.issueDate) continue;
      const key = inv.issueDate.toISOString().slice(0, 7);
      invoicedByKey.set(key, (invoicedByKey.get(key) ?? 0) + invoicedAmount(inv));
    }
    const collectedByKey = new Map<string, number>();
    for (const p of data.payments) {
      if (!p.paidAt) continue;
      const key = zonedMonthKey(p.paidAt, tz);
      collectedByKey.set(
        key,
        (collectedByKey.get(key) ?? 0) + Number(p.amount) - Number(p.refundedAmount),
      );
    }

    const totalInvoiced = data.all.reduce((sum, r) => sum + invoicedAmount(r), 0);
    // Facturas, sin los abonos (que restan pero no son facturas al cliente).
    const invoices = data.all.filter((r) => Number(r.total) > 0);
    const invoicesTotal = invoices.reduce((sum, r) => sum + Number(r.total), 0);

    return {
      currency: tenant.currency,
      totalInvoiced: round2(totalInvoiced),
      totalCollected: data.collectedTotal,
      totalPending: data.owed.total,
      invoiceCount: invoices.length,
      overdueCount: data.owed.overdueInvoices,
      avgInvoice: invoices.length > 0 ? round2(invoicesTotal / invoices.length) : 0,
      monthly: months.map((m) => ({
        label: m.label,
        invoiced: round2(invoicedByKey.get(m.key) ?? 0),
        collected: round2(collectedByKey.get(m.key) ?? 0),
      })),
    };
  }

  /** Inquilinos (customers) del tenant con nº de contratos (total y vigentes). */
  /**
   * Inquilinos del tenant (los 500 más recientes, sin el de prueba). Al rol
   * soporte se le enseña solo el final del documento de identidad.
   */
  async listCustomers(
    tenantId: string,
    opts: { maskDocuments?: boolean } = {},
  ): Promise<AdminTenantCustomerDto[]> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const [customers, activeContracts] = await Promise.all([
      this.admin.customer.findMany({
        where: { tenantId, deletedAt: null, isTest: false },
        include: { _count: { select: { contracts: { where: { deletedAt: null } } } } },
        orderBy: { createdAt: 'desc' },
        take: ADMIN_CUSTOMERS_LIMIT,
      }),
      this.admin.contract.groupBy({
        by: ['customerId'],
        where: { tenantId, ...LIVE_CONTRACT_WHERE },
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
        documentNumber:
          opts.maskDocuments && c.documentNumber
            ? `***${c.documentNumber.slice(-4)}`
            : c.documentNumber,
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

  /**
   * Inquilinos del tenant por páginas, con buscador en el servidor. Marca el de
   * prueba y los borrados, y da la deuda de cada uno con la definición del
   * Resumen (`receivables`: emitido sin cobrar, aparte lo ya vencido).
   */
  async listCustomersPage(
    tenantId: string,
    opts: {
      cursor?: string | undefined;
      limit?: number | undefined;
      search?: string | undefined;
      maskDocuments?: boolean;
    },
  ): Promise<AdminTenantCustomersPageDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const take = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const q = opts.search?.trim();
    const like = q ? { contains: q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.CustomerWhereInput = {
      tenantId,
      ...(like
        ? {
            OR: [
              { firstName: like },
              { lastName: like },
              { companyName: like },
              { email: like },
              { phone: like },
              { documentNumber: like },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.admin.customer.findMany({
        where,
        include: { _count: { select: { contracts: { where: { deletedAt: null } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      }),
      this.admin.customer.count({ where }),
    ]);
    const page = rows.slice(0, take);
    const ids = page.map((c) => c.id);
    const now = new Date();
    const [activeContracts, invoices] = await Promise.all([
      this.admin.contract.groupBy({
        by: ['customerId'],
        where: { tenantId, customerId: { in: ids }, ...LIVE_CONTRACT_WHERE },
        _count: { _all: true },
      }),
      // La misma definición de «pendiente de cobro» que el Resumen.
      this.admin.invoice.findMany({
        where: {
          tenantId,
          customerId: { in: ids },
          status: { in: ['issued', 'overdue', 'partially_refunded'] },
          deletedAt: null,
          kind: 'invoice',
        },
        select: { customerId: true, dueDate: true, total: true, amountPaid: true },
      }),
    ]);
    const activeBy = new Map(activeContracts.map((c) => [c.customerId, c._count._all]));
    const debtBy = new Map<string, { debt: number; overdue: number }>();
    for (const inv of invoices) {
      if (!inv.customerId) continue;
      const pending = Number(inv.total) - Number(inv.amountPaid);
      if (pending <= 0) continue;
      const d = debtBy.get(inv.customerId) ?? { debt: 0, overdue: 0 };
      d.debt += pending;
      if (inv.dueDate && inv.dueDate < now) d.overdue += pending;
      debtBy.set(inv.customerId, d);
    }
    return {
      items: page.map((c) => {
        const name =
          c.customerType === 'business'
            ? (c.companyName ?? c.email ?? '—')
            : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || '—';
        const d = debtBy.get(c.id);
        return {
          id: c.id,
          name,
          customerType: c.customerType,
          email: c.email,
          phone: c.phone,
          documentType: c.documentType,
          documentNumber:
            opts.maskDocuments && c.documentNumber
              ? `***${c.documentNumber.slice(-4)}`
              : c.documentNumber,
          kycVerified: c.kycVerified,
          contractCount: c._count.contracts,
          activeContractCount: activeBy.get(c.id) ?? 0,
          createdAt: c.createdAt.toISOString(),
          isTest: c.isTest,
          deletedAt: c.deletedAt?.toISOString() ?? null,
          debt: round2(d?.debt ?? 0),
          overdueDebt: round2(d?.overdue ?? 0),
        };
      }),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      total,
    };
  }

  /** Locales del tenant por páginas, con buscador en el servidor. */
  async listFacilitiesPage(
    tenantId: string,
    opts: { cursor?: string | undefined; limit?: number | undefined; search?: string | undefined },
  ): Promise<AdminTenantFacilitiesPageDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const take = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const q = opts.search?.trim();
    const like = q ? { contains: q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.FacilityWhereInput = {
      tenantId,
      deletedAt: null,
      ...(like ? { OR: [{ name: like }, { city: like }, { address: like }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.admin.facility.findMany({
        where,
        include: { _count: { select: { units: true } } },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: take + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      }),
      this.admin.facility.count({ where }),
    ]);
    const page = rows.slice(0, take);
    const occupied = await this.admin.unit.groupBy({
      by: ['facilityId'],
      where: { tenantId, status: 'occupied', facilityId: { in: page.map((f) => f.id) } },
      _count: { _all: true },
    });
    const occupiedBy = new Map(occupied.map((o) => [o.facilityId, o._count._all]));
    return {
      items: page.map((f) => ({
        id: f.id,
        name: f.name,
        city: f.city,
        address: f.address,
        unitCount: f._count.units,
        occupiedCount: occupiedBy.get(f.id) ?? 0,
        isActive: f.isActive,
      })),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      total,
    };
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
    const trialAlive = !!tenant.trialEndsAt && tenant.trialEndsAt.getTime() > Date.now();
    const targetStatus = trialAlive ? 'trial' : 'active';
    // Con la prueba ya vencida y la suscripción aún en prueba, queda como al
    // vencer sola: solo lectura hasta que elija cómo pagar (si no, nadie la
    // recogería: el vencimiento automático solo mira tenants en prueba).
    if (!trialAlive) {
      const sub = await this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: { status: true, billingMode: true },
      });
      if (sub?.status === 'trial') {
        const willCharge = sub.billingMode === 'sepa' || sub.billingMode === 'redsys';
        await this.admin.tenantSubscription.update({
          where: { tenantId },
          data: { status: willCharge ? 'active' : 'expired' },
        });
      }
    }

    await this.admin.tenant.update({
      where: { id: tenantId },
      // El tenant vuelve: deja de ser churn (se limpia motivo + fecha de baja).
      data: {
        status: targetStatus,
        churnReason: null,
        canceledAt: null,
        ...(trialAlive ? {} : { trialEndsAt: null }),
      },
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
    } else if (tenant.billingExempt) {
      // Deja de estar exento: el periodo empieza hoy (sin arrastrar la deuda de
      // los meses en que no pagaba). Con Stripe el periodo lo lleva Stripe.
      const sub = await this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: { billingMode: true, stripeSubscriptionId: true },
      });
      const now = new Date();
      const nextMonth = addMonthsUtc(now, 1);
      if (sub && !(sub.billingMode === 'stripe' && sub.stripeSubscriptionId)) {
        await this.admin.tenantSubscription.update({
          where: { tenantId },
          data: { currentPeriodStart: now, currentPeriodEnd: nextMonth },
        });
      }
      // Los extras que se cobran a mano tampoco arrastran cuotas atrasadas.
      await this.admin.tenantSubscriptionAddon.updateMany({
        where: { tenantId, billingMode: 'manual', suspendedAt: null },
        data: { nextChargeAt: nextMonth },
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
    // Como al vencer sola: sin pagar, la cuenta queda en solo lectura con su
    // plan hasta que elija cómo pagar (si ya hubiera pagado, el propio pago la
    // habría pasado a `active` y no llegaría aquí en `trial`).
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    // La misma regla que al vencer sola: quien ya eligió domiciliación o
    // tarjeta guardada se cobra solo (no pasa a solo lectura); un cobro de
    // Stripe que falló sigue con su impago.
    const sub = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      select: { billingMode: true },
    });
    const willCharge = sub?.billingMode === 'sepa' || sub?.billingMode === 'redsys';
    await this.admin.tenantSubscription.updateMany({
      where: { tenantId, status: { notIn: ['active', 'past_due'] } },
      data: { status: willCharge ? 'active' : 'expired' },
    });
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
    // Prueba vencida sin pagar (solo lectura): tampoco paga.
    const expired = sub?.status === 'expired';
    const paying =
      tenant.status !== 'trial' &&
      sub?.status !== 'trial' &&
      !expired &&
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
    // Sigue en prueba: el fin del periodo es el de la prueba (si no, el cobro
    // y las métricas leerían la fecha antigua).
    if (sub?.status === 'trial' && !onFree && tenant.status !== 'cancelled') {
      await this.admin.tenantSubscription.update({
        where: { tenantId },
        data: { currentPeriodEnd: newTrialEndsAt },
      });
    }
    // Prueba vencida sin pagar: vuelve a probar con su mismo plan.
    if (expired && !onFree && tenant.status !== 'cancelled') {
      await this.admin.tenantSubscription.update({
        where: { tenantId },
        data: { status: 'trial', currentPeriodEnd: newTrialEndsAt },
      });
    }
    // En el plan gratuito: vuelve a probar con el plan de la prueba, como al registrarse.
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
  ): Promise<ExtendTrialsBatchResultDto> {
    let updated = 0;
    const skipped: ExtendTrialsBatchResultDto['skipped'] = [];
    // Solo los que están en prueba: el lote no devuelve a prueba a un tenant
    // activo en Free (eso se hace a propósito desde su ficha). Sin duplicados.
    const ids = [...new Set(tenantIds)];
    const rows = await this.admin.tenant.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, status: true, deletedAt: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const tenantId of ids) {
      const t = byId.get(tenantId);
      if (!t || t.deletedAt) {
        skipped.push({ tenantId, name: t?.name ?? null, reason: 'No existe o está borrado' });
        continue;
      }
      if (t.status !== 'trial') {
        skipped.push({ tenantId, name: t.name, reason: 'No está en prueba' });
        continue;
      }
      try {
        await this.extendTrial(tenantId, args);
        updated += 1;
      } catch (err) {
        // Se salta sin abortar el lote, y se dice por qué.
        this.logger.warn(`extendTrialsBatch: no se pudo extender ${tenantId}: ${String(err)}`);
        const message =
          err instanceof BadRequestException || err instanceof NotFoundException
            ? ((err.getResponse() as { message?: string }).message ?? err.message)
            : 'No se pudo ampliar';
        skipped.push({ tenantId, name: t.name, reason: message });
      }
    }
    return { updated, skipped };
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
    // Las mismas reglas que la puesta en marcha que ve el tenant
    // (`OnboardingService`): sin el inquilino de prueba, sin locales borrados,
    // sin reservas online sin pagar ni contratos cancelados.
    const d = await this.prisma.withTenant(async (tx) => {
      const [
        tenant,
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
        stripe,
      ] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            portalLogoUrl: true,
            portalBrandColor: true,
            invoicingMode: true,
            verifactuEnabled: true,
            transferIban: true,
            offlineCashEnabled: true,
            offlineTransferEnabled: true,
            offlineSepaEnabled: true,
          },
        }),
        tx.facility.count({ where: { deletedAt: null } }),
        tx.unit.count({ where: { facility: { deletedAt: null } } }),
        tx.customer.count({
          where: {
            deletedAt: null,
            isTest: false,
            NOT: { contracts: { some: { firstPaymentDeadline: { not: null } } } },
          },
        }),
        tx.contract.count({
          where: {
            deletedAt: null,
            status: { not: 'cancelled' },
            firstPaymentDeadline: null,
            customer: { isTest: false },
          },
        }),
        tx.tenantAeatCredential.count({ where: { ownerId: null, revokedAt: null } }),
        tx.invoiceSeries.count({
          where: { isActive: true, isRectification: false, ownerId: null },
        }),
        tx.invoice.count({
          where: { kind: 'invoice', deletedAt: null, status: { notIn: ['draft', 'cancelled'] } },
        }),
        tx.user.count({ where: { isActive: true } }),
        tx.redsysSettings.count({ where: { enabled: true } }),
        tx.goCardlessSettings.count({ where: { enabled: true } }),
        tx.sepaSettings.count({ where: { enabled: true } }),
        tx.tenantStripeAccount.count({ where: { chargesEnabled: true } }),
      ]);
      return {
        tenant,
        facilities,
        units,
        customers,
        contracts,
        aeat,
        series,
        issuedInvoices,
        activeUsers,
        gateways: redsys + gocardless + sepa + stripe,
      };
    }, tenantId);
    const ownerVerified = await this.admin.user.count({
      where: { tenantId, role: 'owner', emailVerifiedAt: { not: null } },
    });
    const t = d.tenant;
    const paymentsReady =
      d.gateways > 0 ||
      Boolean(t?.transferIban) ||
      Boolean(t?.offlineCashEnabled) ||
      Boolean(t?.offlineTransferEnabled) ||
      Boolean(t?.offlineSepaEnabled);
    const items: AdminOnboardingDto['items'] = [
      { key: 'email_verified', label: 'Email del propietario verificado', done: ownerVerified > 0 },
      { key: 'facility', label: 'Primer local creado', done: d.facilities > 0 },
      { key: 'unit', label: 'Primer trastero creado', done: d.units > 0 },
      { key: 'customer', label: 'Primer inquilino dado de alta', done: d.customers > 0 },
      { key: 'contract', label: 'Primer contrato', done: d.contracts > 0 },
      {
        key: 'branding',
        label: 'Marca del portal configurada',
        done: Boolean(t?.portalLogoUrl || t?.portalBrandColor),
      },
      { key: 'invoice_series', label: 'Serie de facturación creada', done: d.series > 0 },
      { key: 'first_invoice', label: 'Primera factura emitida', done: d.issuedInvoices > 0 },
      {
        key: 'payments',
        label: 'Forma de cobro (tarjeta, domiciliación, IBAN o cobro en el local)',
        done: paymentsReady,
      },
      // En modo Holded la factura la registra Holded; sin Veri*Factu activado el
      // certificado no se usa todavía.
      ...(t?.invoicingMode === 'holded'
        ? []
        : [
            {
              key: 'verifactu',
              label: 'Veri*Factu activado con el certificado AEAT',
              done: !!t?.verifactuEnabled && d.aeat > 0,
            },
          ]),
      { key: 'team', label: 'Equipo invitado (2 o más usuarios)', done: d.activeUsers > 1 },
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
    await reconcileCustomDomainPause(this.admin, tenantId);
    return this.getFeatures(tenantId);
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
    // El plan gratuito ya no se ofrece: quien deja de pagar queda en solo lectura.
    if (plan.slug === 'free') {
      throw new BadRequestException({
        code: 'plan_retired',
        message: 'El plan gratuito ya no se asigna. Para no cobrarle, márcala como exenta.',
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
    // A un plan gratis la cuota deja de deberse: sin esto seguía «pago
    // pendiente» y el escalado de impagos lo acababa suspendiendo.
    const clearsDebt = Number(plan.priceMonthly) <= 0 && subscription.status === 'past_due';
    await this.admin.tenantSubscription.update({
      where: { tenantId },
      data: {
        planId: plan.id,
        ...(subscription.status === 'trial' || clearsDebt ? { status: 'active' as const } : {}),
      },
    });
    if (tenant.status === 'trial') {
      await this.admin.tenant.update({
        where: { id: tenantId },
        data: { status: 'active', trialEndsAt: null },
      });
    }
    // Extras que el plan nuevo ya incluye o no admite (con aviso) y trasteros de más.
    const removedAddons = await this.saasBilling
      .reconcileAddonsAfterPlanChange(tenantId)
      .catch(() => [] as string[]);
    const changes = {
      reason: args.reason,
      previousPlan: previousSlug,
      ...(removedAddons.length ? { removedAddons } : {}),
      newPlan: plan.slug,
      ...(endsTrial ? { endedTrial: true } : {}),
      ...(clearsDebt ? { clearedDebt: true } : {}),
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
    // Una propuesta de cuota con este plan queda aceptada.
    await this.admin.platformQuoteOffer
      .updateMany({
        where: {
          tenantId,
          planId: plan.id,
          status: 'sent',
          // Una caducada ya no se acepta sola.
          OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
        },
        data: { status: 'accepted', resolvedAt: new Date() },
      })
      .catch(() => undefined);
    // Un plan sin dominio propio deja el suyo en pausa (y al revés).
    await reconcileCustomDomainPause(this.admin, tenantId);
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
      billableUnits(this.admin, tenantId),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      // Como el límite real: usuarios activos + invitaciones pendientes.
      this.admin.invitation.count({
        where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId, suspendedAt: null },
        include: {
          addon: { select: { name: true, feature: true, planSlugs: true, isSystem: true } },
        },
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
    // Se dan de baja al cambiar: los que el plan nuevo ya incluye o no admite.
    const redundantAddons = addons
      .filter(
        (a) =>
          !a.addon.isSystem &&
          ((a.addon.feature && newFeatures.has(a.addon.feature)) ||
            (a.addon.planSlugs.length > 0 && !a.addon.planSlugs.includes(newPlan.slug))),
      )
      .map((a) => ({ name: a.addon.name, feature: a.addon.feature ?? '' }));

    const overLimits: { resource: string; used: number; limit: number }[] = [];
    const check = (resource: string, used: number, limit: number | null) => {
      if (limit !== null && used > limit) overLimits.push({ resource, used, limit });
    };
    check('units', units, newPlan.maxUnits);
    check('facilities', facilities, newPlan.maxFacilities);
    check('users', users + invites, newPlan.maxUsers);

    // Con un plan por trastero, la cuota lleva los trasteros de más.
    const unitAddon = await this.admin.subscriptionAddon.findUnique({
      where: { slug: EXTRA_UNITS_ADDON_SLUG },
      select: { priceMonthly: true },
    });
    const unitPrice = Number(unitAddon?.priceMonthly ?? 0);
    const extraUnits = extraUnitsFor(units, newPlan.includedUnits);
    const currentExtra = extraUnitsFor(units, subscription.plan.includedUnits);
    const currentPrice = Number(subscription.plan.priceMonthly) + currentExtra * unitPrice;
    const newPrice = Number(newPlan.priceMonthly) + extraUnits * unitPrice;
    const chargedByStripe =
      !!subscription.stripeSubscriptionId && subscription.billingMode === 'stripe';
    // Cuotas vencidas: se cuentan a la cuota del plan que tenga cuando las pague.
    const owedPeriods =
      subscription.status === 'past_due'
        ? periodsOwed(subscriptionDueDate(subscription), new Date(), 1, chargedByStripe)
        : 0;
    const tenantRow = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return {
      chargedByStripe,
      owedPeriods,
      inTrial: tenantRow?.status === 'trial' || subscription.status === 'trial',
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
      extraUnits,
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

    // Primero, que deje de cobrársele (Stripe confirma la cancelación o no se
    // sigue): un tenant anonimizado no puede seguir pagando.
    await this.saasBilling.stopChargingForAnonymize(tenantId);
    // Los inquilinos que cuenta el aviso: los mismos que la vista previa.
    const liveCustomers = await this.admin.customer.count({
      where: { tenantId, deletedAt: null, isTest: false },
    });

    const counts = await this.admin.$transaction(async (tx) => {
      await tx.customer.updateMany({
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
          billingEmail: null,
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
          holderName: null,
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
        select: { attachmentKey: true, extraAttachments: true },
      });
      await tx.customerMessage.updateMany({
        where: { tenantId },
        data: {
          body: ANON,
          attachmentKey: null,
          attachmentMime: null,
          attachmentName: null,
          extraAttachments: [],
        },
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
      await tx.delinquencyPickupRequest.updateMany({
        where: { tenantId },
        data: { note: null, resolutionNote: null },
      });
      // Reglas de la conciliación con el nombre de un inquilino (las de gastos, no).
      await tx.bankMatchRule.deleteMany({ where: { tenantId, customerId: { not: null } } });
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

      // Lo que quedaba con datos de inquilinos o del equipo fuera de sus fichas.
      await tx.incident.updateMany({
        where: { tenantId },
        data: {
          title: ANON,
          description: null,
          photos: [],
          reportedByExternal: null,
          resolution: null,
          metadata: {},
        },
      });
      await tx.reservation.updateMany({
        where: { tenantId },
        data: { notes: null, cancelReason: null },
      });
      await tx.notification.updateMany({ where: { tenantId }, data: { title: ANON, body: null } });
      await tx.leadActivity.updateMany({ where: { tenantId }, data: { content: ANON } });
      await tx.leadFollowup.updateMany({ where: { tenantId }, data: { title: ANON, note: null } });
      await tx.leadVisit.updateMany({ where: { tenantId }, data: { notes: null } });
      await tx.customerOffer.updateMany({ where: { tenantId }, data: { message: ANON } });
      await tx.retentionOffer.updateMany({ where: { tenantId }, data: { message: null } });
      await tx.dataSubjectRequest.updateMany({
        where: { tenantId },
        data: { email: ANON, notes: null, rejectionReason: null, exportFileUrl: null },
      });
      await tx.aiMessage.updateMany({
        where: { tenantId },
        data: { content: ANON, toolsUsed: {} },
      });
      await tx.webhookDelivery.updateMany({
        where: { tenantId },
        data: { payload: {}, responseBody: null, errorMessage: null },
      });
      await tx.emailSuppression.deleteMany({ where: { tenantId } });
      await tx.expenseSupplier.updateMany({
        where: { tenantId },
        data: { name: ANON, taxId: null, email: null, phone: null, notes: null },
      });
      await tx.businessReminder.updateMany({
        where: { tenantId },
        data: { extraEmails: [], notes: null },
      });
      await tx.reportSchedule.updateMany({
        where: { tenantId },
        data: { recipients: [], isActive: false },
      });
      await tx.ownerStatement.updateMany({ where: { tenantId }, data: { sentTo: null } });
      await tx.invitation.updateMany({
        where: { tenantId },
        data: { email: ANON, revokedAt: now, revokedReason: 'tenant_anonymized' },
      });
      // Puertas y cámaras: desactivadas y sin claves (no pueden seguir hablando
      // con la plataforma en nombre del negocio).
      await tx.accessDevice.updateMany({
        where: { tenantId },
        data: {
          isActive: false,
          apiKeyHash: null,
          apiKeyPreview: null,
          controlSecretEncrypted: null,
        },
      });
      // El token de ingesta es único: se cambia por uno al azar que nadie conoce.
      const cameras = await tx.cameraDevice.findMany({ where: { tenantId }, select: { id: true } });
      for (const c of cameras) {
        await tx.cameraDevice.update({
          where: { id: c.id },
          data: {
            isActive: false,
            controlSecretEncrypted: null,
            ingestTokenHash: `revoked-${randomBytes(24).toString('hex')}`,
            ingestTokenPreview: '',
          },
        });
      }
      // Justificantes del depósito de fianzas de vivienda (llevan datos del inquilino).
      const depositReceipts = await tx.contract.findMany({
        where: { tenantId, depositRegistryReceiptKey: { not: null } },
        select: { depositRegistryReceiptKey: true },
      });
      await tx.contract.updateMany({
        where: { tenantId, depositRegistryReceiptKey: { not: null } },
        data: { depositRegistryReceiptKey: null },
      });
      // El mandato SEPA y la tarjeta con los que nos pagaba la suscripción.
      await tx.platformSepaMandate.updateMany({
        where: { tenantId },
        data: {
          status: 'cancelled',
          ibanEncrypted: '',
          bic: null,
          debtorName: null,
          debtorAddress: null,
          debtorPostalCode: null,
          debtorCity: null,
          signerName: null,
          signatureImage: null,
          typedSignature: null,
          documentText: null,
          signedIp: null,
          signedUserAgent: null,
        },
      });
      await tx.platformRedsysCard.deleteMany({ where: { tenantId } });
      // Más texto libre que puede llevar nombres, teléfonos o lo hablado.
      await tx.aiConversation.updateMany({ where: { tenantId }, data: { title: ANON } });
      await tx.aiScheduledQuestion.deleteMany({ where: { tenantId } });
      await tx.aiPendingAction.deleteMany({ where: { tenantId } });
      await tx.task.updateMany({
        where: { tenantId },
        data: { title: ANON, description: null, cancelReason: null, metadata: {} },
      });
      await tx.taskComment.updateMany({ where: { tenantId }, data: { body: ANON } });
      await tx.businessReminderCompletion.updateMany({ where: { tenantId }, data: { note: null } });
      await tx.incidentComment.updateMany({ where: { tenantId }, data: { body: ANON } });
      await tx.delinquencyCase.updateMany({
        where: { tenantId },
        data: { notes: null, custodyLocation: null, noticeTracking: null },
      });
      await tx.delinquencyCaseEvent.updateMany({ where: { tenantId }, data: { payload: {} } });
      await tx.paymentPlan.updateMany({ where: { tenantId }, data: { notes: null } });
      await tx.consent.updateMany({ where: { tenantId }, data: { evidence: {} } });
      await tx.automationRun.updateMany({
        where: { tenantId },
        data: { eventPayload: {}, errorMessage: null },
      });
      await tx.accessLog.updateMany({
        where: { tenantId },
        data: { attemptedValue: null, ipAddress: null, metadata: {} },
      });
      const snapshots = await tx.cameraEvent.findMany({
        where: { tenantId, snapshotKey: { not: null } },
        select: { snapshotKey: true },
      });
      await tx.cameraEvent.deleteMany({ where: { tenantId } });
      // Comprobaciones y casillas de su dominio propio (las tareas de limpieza del Proxy Host se conservan).
      await tx.platformDomainCheck.deleteMany({ where: { tenantId } });
      await tx.platformDomainChecklist.deleteMany({ where: { tenantId } });
      // Lo que se guardó de la relación con la plataforma: sin contacto ni lo hablado.
      await tx.tenantInteraction.updateMany({ where: { tenantId }, data: { content: ANON } });
      await tx.platformEmailLog.updateMany({
        where: { tenantId },
        data: { recipient: ANON, bodyText: null, bodyHtml: null },
      });
      await tx.platformNpsResponse.updateMany({
        where: { tenantId },
        data: { email: ANON, comment: null },
      });
      await tx.platformLegalAcceptance.updateMany({
        where: { tenantId },
        data: { ipAddress: null },
      });
      await tx.supportTicket.updateMany({
        where: { tenantId },
        data: { userAgent: null, pageUrl: null, ratingComment: null },
      });
      // Enlaces de un solo uso que ya no se van a usar.
      await tx.passwordResetToken.deleteMany({ where: { tenantId } });
      await tx.emailVerificationToken.deleteMany({ where: { tenantId } });
      await tx.recoveryCode.deleteMany({ where: { tenantId } });

      await tx.customerDocument.deleteMany({ where: { tenantId } });
      await tx.customerDocumentRequest.deleteMany({ where: { tenantId } });
      await tx.customerContact.deleteMany({ where: { tenantId } });
      await tx.customerAuthorizedPerson.deleteMany({ where: { tenantId } });
      // Trasteros cedidos: sin el nombre ni el teléfono de a quién se cedieron.
      await tx.unitCession.updateMany({
        where: { tenantId },
        data: { holderName: '*** ANONIMIZADO ***', holderPhone: null, notes: null },
      });
      // Firmas y condiciones aceptadas: se conservan como prueba, sin IP,
      // navegador ni email de quien firmó.
      await tx.contractSignature.updateMany({
        where: { tenantId },
        data: { ipAddress: null, userAgent: null, signerEmail: null },
      });
      await tx.contractAnnex.updateMany({
        where: { tenantId },
        data: { ipAddress: null, userAgent: null, sentTo: null },
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
      // Su lead del panel admin: se queda la fase y el origen (cifras), sin
      // datos de contacto ni lo hablado.
      const lead = await tx.platformLead.findUnique({ where: { tenantId }, select: { id: true } });
      if (lead) {
        await tx.platformLeadActivity.deleteMany({ where: { leadId: lead.id } });
        await tx.platformLeadFollowup.deleteMany({ where: { leadId: lead.id } });
        // La ficha del comercial (nota fijada, quién decide…) también.
        await tx.salesAccountProfile.deleteMany({ where: { leadId: lead.id } });
        await tx.platformLead.update({
          where: { id: lead.id },
          data: {
            companyName: ANON,
            contactName: null,
            email: null,
            phone: null,
            message: null,
            city: null,
            lostReason: null,
          },
        });
      }
      // Chat con IA de la web: lo que escribieron los visitantes.
      await tx.webChatConversation.deleteMany({ where: { tenantId } });
      // La cuenta de Stripe del tenant (la cuenta sigue en Stripe, a su nombre).
      await tx.tenantStripeAccount.deleteMany({ where: { tenantId } });
      // Instagram y Facebook: fuera el token de la página y lo descargado.
      await tx.socialPost.deleteMany({ where: { tenantId } });
      await tx.socialDailyMetric.deleteMany({ where: { tenantId } });
      await tx.tenantSocialAccount.deleteMany({ where: { tenantId } });
      // Anuncios y Google: fuera las credenciales (si no, se seguían usando cada
      // día) y lo descargado de Google Analytics y Search Console.
      await tx.googleAdsSettings.deleteMany({ where: { tenantId } });
      await tx.metaAdsSettings.deleteMany({ where: { tenantId } });
      await tx.ga4SourceRow.deleteMany({ where: { tenantId } });
      await tx.ga4PageRow.deleteMany({ where: { tenantId } });
      await tx.tenantGa4.deleteMany({ where: { tenantId } });
      await tx.searchConsoleRow.deleteMany({ where: { tenantId } });
      await tx.searchConsoleDay.deleteMany({ where: { tenantId } });
      await tx.searchConsoleDevice.deleteMany({ where: { tenantId } });
      await tx.seoTrackedKeyword.deleteMany({ where: { tenantId } });
      await tx.tenantSearchConsole.deleteMany({ where: { tenantId } });
      // SEO Avanzado: las oportunidades y SISTRIX (su clave cifrada, sus ajustes, lo descargado con
      // ella, el registro de peticiones, competidores y palabras del proyecto).
      await tx.seoOpportunity.deleteMany({ where: { tenantId } });
      await tx.seoApiRequest.deleteMany({ where: { tenantId } });
      await tx.seoApiCache.deleteMany({ where: { tenantId } });
      await tx.seoKeywordMetric.deleteMany({ where: { tenantId } });
      await tx.seoDomainMetric.deleteMany({ where: { tenantId } });
      await tx.seoDomainKeyword.deleteMany({ where: { tenantId } });
      await tx.seoSerpResult.deleteMany({ where: { tenantId } });
      await tx.seoDomainOpportunity.deleteMany({ where: { tenantId } });
      await tx.seoBacklinkTarget.deleteMany({ where: { tenantId } });
      await tx.seoAiVisibility.deleteMany({ where: { tenantId } });
      await tx.seoProjectKeyword.deleteMany({ where: { tenantId } });
      await tx.seoCompetitor.deleteMany({ where: { tenantId } });
      await tx.seoProviderConnection.deleteMany({ where: { tenantId } });
      await tx.seoSyncSettings.deleteMany({ where: { tenantId } });
      // SEO Avanzado: el proyecto, sus dominios, lo descargado, lo importado y las descargas.
      await tx.seoSyncRun.deleteMany({ where: { tenantId } });
      await tx.seoGscImportRow.deleteMany({ where: { tenantId } });
      await tx.seoGscImport.deleteMany({ where: { tenantId } });
      await tx.seoGscMetric.deleteMany({ where: { tenantId } });
      await tx.seoProjectDomain.deleteMany({ where: { tenantId } });
      await tx.seoProject.deleteMany({ where: { tenantId } });

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
            pendingEmail: null,
            emailChangeTokenHash: null,
            termsAcceptedIp: null,
            termsAcceptedUserAgent: null,
            isActive: false,
            tokensValidAfter: now,
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
          accountantEmail: null,
          accountantReportFrequency: 'off',
          aiOwnApiKeyEncrypted: null,
          remindersIcsTokenHash: null,
          remindersIcsTokenEncrypted: null,
          billingLegalName: null,
          billingAddress: null,
          billingCity: null,
          billingPostalCode: null,
          strategicNotes: null,
          emailReplyTo: null,
          // Libera el dominio para otro.
          customDomain: null,
          customDomainVerifiedAt: null,
          customDomainReadyAt: null,
          customDomainPausedVerifiedAt: null,
          customDomainCheckedAt: null,
          customDomainCheckOk: null,
          customDomainCheckIssue: null,
          // Lo programado ya no hace falta.
          cancelScheduledAt: null,
          cancelScheduledReason: null,
          cancelScheduledNote: null,
          cancelScheduledBy: null,
          anonymizeScheduledAt: null,
          anonymizeScheduledReason: null,
          anonymizeScheduledBy: null,
        },
      });
      // Las exportaciones hechas (Excel con sus datos) también se borran.
      await tx.tenantDataExport.deleteMany({ where: { tenantId } });

      return {
        customers: liveCustomers,
        users: users.length,
        leads: leads.count,
        communications: communications.count,
        whatsappConversations: whatsapp.count,
        fileKeys: [
          ...whatsapp.mediaKeys,
          ...depositReceipts.map((c) => c.depositRegistryReceiptKey!),
          ...snapshots.map((c) => c.snapshotKey!),
          ...faces.map((f) => f.facePhotoKey!),
          ...photos.map((p) => p.key),
          ...chatFiles.flatMap(attachmentKeysOf),
        ],
      };
    }, ANONYMIZE_TX_OPTIONS);

    const changes = {
      reason: meta.reason,
      anonymizedCustomers: counts.customers,
      anonymizedUsers: counts.users,
      anonymizedLeads: counts.leads,
      anonymizedCommunications: counts.communications,
      anonymizedWhatsappConversations: counts.whatsappConversations,
    };
    await this.files.deleteObjects('uploads', counts.fileKeys);
    await this.files
      .deleteByPrefix('reports', `${tenantId}/exports/`)
      .catch((err: unknown) =>
        this.logger.warn(`anonymize: no se pudo borrar exports/ de ${tenantId}: ${String(err)}`),
      );
    // Documentos de los inquilinos y adjuntos que quedaran sueltos (las facturas
    // y los contratos firmados se conservan, como en el RGPD de un inquilino).
    for (const prefix of ANONYMIZE_FILE_PREFIXES) {
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
    deletedAt?: Date | null;
    canceledAt?: Date | null;
    churnReason?: string | null;
    cancelScheduledAt?: Date | null;
    cancelScheduledReason?: string | null;
    cancelScheduledNote?: string | null;
    anonymizeScheduledAt?: Date | null;
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
      anonymizedAt: row.deletedAt?.toISOString() ?? null,
      canceledAt: row.canceledAt?.toISOString() ?? null,
      churnReason: row.churnReason ?? null,
      cancelScheduledAt: row.cancelScheduledAt?.toISOString() ?? null,
      cancelScheduledReason: row.cancelScheduledReason ?? null,
      cancelScheduledNote: row.cancelScheduledNote ?? null,
      anonymizeScheduledAt: row.anonymizeScheduledAt?.toISOString() ?? null,
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
