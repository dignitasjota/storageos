import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  EXTRA_UNITS_ADDON_SLUG,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MIME_TYPES,
  PLATFORM_LEAD_BOARD_OPEN_LIMIT,
  PLATFORM_LEAD_DISCARD_REASON_LABELS,
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_MAX_ATTACHMENTS,
  PLATFORM_LEAD_REPLY_TYPES,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_TRIAL_LOST_GRACE_DAYS,
  PLATFORM_LEAD_TRIAL_RECONTACT_DAYS,
  PLATFORM_LEAD_UNATTENDED_HOURS,
  attachmentLabel,
  estimatePlatformLeadValue,
  findTaxId,
  isRealIsoDay,
  parseRecoverMonths,
  platformLeadName,
  proposeRecoverOn,
  scorePlatformLead,
  similarCompanyNames,
  staleDaysOf,
  stripQuotedReply,
  type EmailInboundInput,
  type MessageAttachmentInput,
  type PlatformLeadDiscardReason,
  type PlatformLeadDuplicateDto,
  type PlatformLeadLostReason as LostReason,
  type PlatformLeadStaleDays,
  type PlatformLeadValueContext,
} from '@storageos/shared';

import { CSV_BOM, csvLineCell } from '../../../common/csv';
import { todayInTimezone } from '../../../common/format';
import {
  assertAttachment,
  attachmentsDto,
  requestAttachmentUpload,
  type StoredAttachment,
} from '../../../common/message-attachments';
import {
  currentMrrByTenant,
  madridMonthIndex,
  monthIndexStart,
} from '../../../common/saas-metrics';
import { platformPricing } from '../../billing-saas/platform-pricing';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { FilesService } from '../../files/files.service';
import { PlatformService } from '../../platform/platform.service';
import { AdminQuoteService } from '../admin-quote.service';
import { AdminTenantInteractionsService } from '../admin-tenant-interactions.service';
import { AdminTenantToolsService } from '../admin-tenant-tools.service';
import { SalesAssignmentService } from '../sales/sales-assignment.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { PlatformLeadMailService, type LeadEmailSender } from './core/platform-lead-mail.service';
import {
  PlatformLeadSequencesService,
  type SequenceStopReason,
} from './core/platform-lead-sequences.service';
import { PlatformLeadSettingsService } from './platform-lead-settings.service';

export type { LeadEmailSender } from './core/platform-lead-mail.service';

import type {
  PlatformLeadInboundEvent,
  PlatformTenantRegisteredEvent,
} from '../../../common/platform-lead-events';
import type {
  AdminCreateTenantInput,
  CreatePlatformLeadActivityInput,
  CreatePlatformLeadFollowupInput,
  CreatePlatformLeadInput,
  LosePlatformLeadInput,
  MovePlatformLeadInput,
  PlatformLeadActivityDto,
  PlatformLeadActivityType,
  PlatformLeadBoardDto,
  PlatformLeadDetailDto,
  PlatformLeadDto,
  PlatformLeadFollowupDto,
  PlatformLeadLostReason,
  PlatformLeadsQuery,
  PlatformLeadSource,
  PlatformLeadStage,
  PlatformLeadStatsDto,
  PlatformLeadTenantRefDto,
  SendAdminQuoteInput,
  SendPlatformLeadEmailInput,
  UpdatePlatformLeadFollowupInput,
  UpdatePlatformLeadInput,
} from '@storageos/shared';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MANUAL_ACTIVITY_TYPES = new Set(['note', 'call', 'demo', 'meeting', 'whatsapp']);
/** Lo que cuenta como haberle respondido (y le pasa de «Nuevo» a «Contactado»). */
const CONTACT_ACTIVITY_TYPES = new Set(['call', 'demo', 'meeting', 'whatsapp']);
/** Orígenes de quien escribe solo (no lo da de alta el equipo ni es un registro directo). */
const INBOUND_SOURCES = new Set(['web_contact', 'demo', 'calculator']);
/** Margen para una actividad anotada «ahora» con el reloj del navegador algo adelantado. */
const FUTURE_MARGIN_MS = 5 * 60_000;
/** Lo que se anota de un cambio de datos (nombres de campo, nunca valores). */
const AUDITED_FIELDS = [
  'companyName',
  'contactName',
  'email',
  'phone',
  'units',
  'facilities',
  'profile',
  'currentSoftware',
  'city',
  'planSlug',
  'source',
  'assignedToId',
] as const;

export const LEAD_INCLUDE = {
  assignedTo: { select: { fullName: true } },
  salesRep: { select: { fullName: true } },
  tenant: {
    select: {
      id: true,
      name: true,
      slug: true,
      deletedAt: true,
      salesRep: { select: { id: true, fullName: true } },
    },
  },
  followups: {
    where: { status: 'pending' },
    orderBy: { dueDate: 'asc' },
    take: 1,
    select: { id: true, title: true, dueDate: true },
  },
  // Las notas automáticas (reparto, propuesta abierta, secuencias) no son actividad
  // del equipo: si contaran, un prospecto recién repartido saldría «contactado hoy».
  activities: {
    where: { type: { not: 'system' } },
    orderBy: { occurredAt: 'desc' },
    take: 1,
    select: { occurredAt: true },
  },
} satisfies Prisma.PlatformLeadInclude;
export type LeadRow = Prisma.PlatformLeadGetPayload<{ include: typeof LEAD_INCLUDE }>;

const FOLLOWUP_INCLUDE = {
  assignedTo: { select: { fullName: true } },
  lead: { select: { companyName: true, contactName: true, email: true } },
} satisfies Prisma.PlatformLeadFollowupInclude;
type FollowupRow = Prisma.PlatformLeadFollowupGetPayload<{ include: typeof FOLLOWUP_INCLUDE }>;

/** Lo que hace falta para la cuota prevista y los parados (se carga una vez). */
export interface LeadInsightContext {
  value: PlatformLeadValueContext;
  stale: PlatformLeadStaleDays;
  highValue: number;
}

const EMPTY_STAGE_COUNTS = (): Record<PlatformLeadStage, number> => ({
  new: 0,
  contacted: 0,
  interested: 0,
  trial: 0,
  customer: 0,
  lost: 0,
});

/** Suma de la cuota prevista por fase («€ en juego»). */
function valueByStage(items: PlatformLeadDto[]): Record<PlatformLeadStage, number> {
  const out = EMPTY_STAGE_COUNTS();
  for (const l of items) out[l.status] += l.estimatedMonthly ?? 0;
  for (const k of Object.keys(out) as PlatformLeadStage[]) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

export interface LeadActor {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const madridToday = (now = new Date()) => isoDate(todayInTimezone('Europe/Madrid', now));
export const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Sin las marcas de archivado: el lead vuelve a la cartera activa (o se pierde sin archivar). */
export const ARCHIVE_CLEAR = {
  salesArchivedAt: null,
  salesRecoverOn: null,
  salesRecoverNotifiedAt: null,
} as const;

/** Cómo queda archivado un perdido de un comercial. */
export interface LeadArchiveOptions {
  /** Volver a intentarlo ese día (undefined = la fecha que toca por el motivo; null = sin fecha). */
  recoverOn?: string | null | undefined;
  /** «No volver a contactar»: sin fecha, sin correos ni recordatorios. */
  doNotContact?: boolean | undefined;
}

const dayLabel = (iso: string) => iso.split('-').reverse().join('/');
export const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

/**
 * Fecha de un seguimiento o de «volver a contactar»: que exista en el
 * calendario y no haya pasado (hoy, en hora de España, sí vale).
 */
function assertUpcomingDay(value: string, now = new Date()): void {
  if (!isRealIsoDay(value)) {
    throw new BadRequestException({ code: 'invalid_date', message: 'Esa fecha no existe' });
  }
  if (value < madridToday(now)) {
    throw new BadRequestException({
      code: 'date_in_past',
      message: 'La fecha ya ha pasado: elige hoy o un día posterior',
    });
  }
}

/** Cuándo pasó una actividad anotada: no puede ser futura (con unos minutos de margen). */
function activityDate(value: string | undefined, now = new Date()): Date {
  if (!value) return now;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException({ code: 'invalid_date', message: 'Fecha no válida' });
  }
  if (at.getTime() > now.getTime() + FUTURE_MARGIN_MS) {
    throw new BadRequestException({
      code: 'date_in_future',
      message: 'La actividad no puede ser de una fecha futura',
    });
  }
  return at.getTime() > now.getTime() ? now : at;
}

export function toLeadFollowupDto(r: FollowupRow): PlatformLeadFollowupDto {
  return {
    id: r.id,
    leadId: r.leadId,
    leadName: platformLeadName(r.lead),
    title: r.title,
    note: r.note,
    dueDate: isoDate(r.dueDate),
    status: r.status === 'done' ? 'done' : 'pending',
    completedAt: r.completedAt?.toISOString() ?? null,
    assignedToId: r.assignedToId,
    assignedToName: r.assignedTo?.fullName ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Leads del panel admin: quien se interesa por TrasterOS. Entran por el
 * formulario de la web, al registrarse o a mano; el equipo los trabaja
 * (conversación, actividad, seguimientos, propuesta) y pasan a «En prueba» al
 * tener cuenta y a «Cliente» con el primer pago.
 */
@Injectable()
export class PlatformLeadsService {
  private readonly logger = new Logger(PlatformLeadsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly platform: PlatformService,
    private readonly tools: AdminTenantToolsService,
    private readonly quotes: AdminQuoteService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly audit: SuperAdminAuditService,
    private readonly assignment: SalesAssignmentService,
    private readonly mail: PlatformLeadMailService,
    private readonly sequences: PlatformLeadSequencesService,
    private readonly settings: PlatformLeadSettingsService,
    private readonly files: FilesService,
  ) {}

  // ------------------------------------------------------------- lectura

  listWhere(q: PlatformLeadsQuery, superAdminId: string): Prisma.PlatformLeadWhereInput {
    const where: Prisma.PlatformLeadWhereInput = {
      discardedAt: q.discarded ? { not: null } : null,
    };
    if (q.source) where.source = q.source;
    if (q.assignedTo === 'me') where.assignedToId = superAdminId;
    else if (q.assignedTo === 'none') where.assignedToId = null;
    else if (q.assignedTo && /^[0-9a-f-]{36}$/i.test(q.assignedTo)) {
      where.assignedToId = q.assignedTo;
    }
    if (q.search) {
      const contains = { contains: q.search, mode: 'insensitive' as const };
      where.OR = [
        { companyName: contains },
        { contactName: contains },
        { email: contains },
        { phone: contains },
        { city: contains },
      ];
    }
    return where;
  }

  async board(q: PlatformLeadsQuery, superAdminId: string): Promise<PlatformLeadBoardDto> {
    const where = this.listWhere(q, superAdminId);
    if (q.discarded) return this.discardedBoard(where);
    const [open, customers, lost, groups] = await Promise.all([
      this.admin.platformLead.findMany({
        where: { ...where, status: { in: ['new', 'contacted', 'interested', 'trial'] } },
        include: LEAD_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PLATFORM_LEAD_BOARD_OPEN_LIMIT,
      }),
      this.admin.platformLead.findMany({
        where: { ...where, status: 'customer' },
        include: LEAD_INCLUDE,
        orderBy: [{ customerAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
      this.admin.platformLead.findMany({
        where: { ...where, status: 'lost' },
        include: LEAD_INCLUDE,
        orderBy: [{ lostAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
      this.admin.platformLead.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    const counts = {
      new: 0,
      contacted: 0,
      interested: 0,
      trial: 0,
      customer: 0,
      lost: 0,
    } as Record<PlatformLeadStage, number>;
    for (const g of groups) {
      if (g.status in counts) counts[g.status as PlatformLeadStage] = g._count._all;
    }
    const openTotal = counts.new + counts.contacted + counts.interested + counts.trial;
    const hiddenOpen = Math.max(openTotal - open.length, 0);
    const items = await this.toDtos([...open, ...customers, ...lost]);
    return {
      items,
      counts,
      valueByStage: valueByStage(items),
      truncated: hiddenOpen > 0,
      hiddenOpen,
    };
  }

  /** Los marcados «No es un lead», del último al primero (para recuperarlos). */
  private async discardedBoard(
    where: Prisma.PlatformLeadWhereInput,
  ): Promise<PlatformLeadBoardDto> {
    const [rows, total, groups] = await Promise.all([
      this.admin.platformLead.findMany({
        where,
        include: LEAD_INCLUDE,
        orderBy: [{ discardedAt: 'desc' }, { id: 'desc' }],
        take: PLATFORM_LEAD_BOARD_OPEN_LIMIT,
      }),
      this.admin.platformLead.count({ where }),
      this.admin.platformLead.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    const counts = {
      new: 0,
      contacted: 0,
      interested: 0,
      trial: 0,
      customer: 0,
      lost: 0,
    } as Record<PlatformLeadStage, number>;
    for (const g of groups) {
      if (g.status in counts) counts[g.status as PlatformLeadStage] = g._count._all;
    }
    const hiddenOpen = Math.max(total - rows.length, 0);
    const items = await this.toDtos(rows);
    return {
      items,
      counts,
      valueByStage: EMPTY_STAGE_COUNTS(),
      truncated: hiddenOpen > 0,
      hiddenOpen,
    };
  }

  /** La ficha (también la de un descartado, que la web abre en solo lectura). */
  async detail(id: string): Promise<PlatformLeadDetailDto> {
    const row = await this.admin.platformLead.findUnique({ where: { id }, include: LEAD_INCLUDE });
    if (!row) throw this.notFound();
    const [[dto], activities, followups, offers, sequence, duplicates] = await Promise.all([
      this.toDtos([row]),
      this.admin.platformLeadActivity.findMany({
        where: { leadId: id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 300,
        include: { superAdmin: { select: { fullName: true } } },
      }),
      this.admin.platformLeadFollowup.findMany({
        where: { leadId: id },
        orderBy: [{ status: 'desc' }, { dueDate: 'asc' }],
        include: FOLLOWUP_INCLUDE,
      }),
      this.quotes.listOffers({ leadId: id, tenantId: row.tenantId }),
      this.sequences.state(id),
      row.discardedAt ? Promise.resolve([]) : this.possibleDuplicates(row),
    ]);
    return {
      ...dto!,
      activities: await Promise.all(
        activities.map(
          async (a): Promise<PlatformLeadActivityDto> => ({
            id: a.id,
            type: a.type as PlatformLeadActivityType,
            subject: a.subject,
            content: a.content,
            occurredAt: a.occurredAt.toISOString(),
            superAdminName: a.superAdmin?.fullName ?? null,
            attachments: await this.activityAttachments(a.attachments),
          }),
        ),
      ),
      followups: followups.map(toLeadFollowupDto),
      quoteOffers: offers.items,
      sequence,
      sequenceOptOut: row.sequenceOptOut,
      duplicates,
      repliesToThread: this.mail.repliesToThread,
    };
  }

  /** Leads de un filtro (lo usa la cartera de cada comercial). */
  async listDtos(where: Prisma.PlatformLeadWhereInput, take = 500): Promise<PlatformLeadDto[]> {
    const rows = await this.admin.platformLead.findMany({
      where: { discardedAt: null, ...where },
      include: LEAD_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return this.toDtos(rows);
  }

  /**
   * Puntuación, cuota prevista y última actividad de muchos leads sin cargar
   * sus fichas (lo usa la cartera del comercial para ordenar todas las
   * páginas). Mismo cálculo que `toDtos`.
   */
  async rankRows(
    rows: {
      id: string;
      status: string;
      source: string;
      units: string | null;
      facilities: string | null;
      planSlug: string | null;
      createdAt: Date;
    }[],
    now = new Date(),
  ): Promise<Map<string, { score: number; monthly: number | null; lastActivityAt: Date | null }>> {
    const out = new Map<
      string,
      { score: number; monthly: number | null; lastActivityAt: Date | null }
    >();
    if (rows.length === 0) return out;
    const context = await this.insightContext();
    const actsOf = new Map<string, Map<string, Date>>();
    const opensOf = new Map<string, number>();
    // Por tandas: la consulta no admite listas enormes de parámetros.
    for (let i = 0; i < rows.length; i += 5000) {
      const ids = rows.slice(i, i + 5000).map((r) => r.id);
      const [acts, opens] = await Promise.all([
        this.admin.platformLeadActivity.groupBy({
          by: ['leadId', 'type'],
          where: { leadId: { in: ids } },
          _max: { occurredAt: true },
        }),
        this.admin.platformQuoteOffer.groupBy({
          by: ['leadId'],
          where: { leadId: { in: ids } },
          _sum: { openCount: true },
        }),
      ]);
      for (const a of acts) {
        if (!a.leadId || !a._max.occurredAt) continue;
        const m = actsOf.get(a.leadId) ?? new Map<string, Date>();
        m.set(a.type, a._max.occurredAt);
        actsOf.set(a.leadId, m);
      }
      for (const o of opens) if (o.leadId) opensOf.set(o.leadId, o._sum.openCount ?? 0);
    }
    const latest = (m: Map<string, Date> | undefined, types?: readonly string[]) => {
      let best: Date | null = null;
      for (const [t, d] of m ?? []) {
        if (types && !types.includes(t)) continue;
        if (!best || d > best) best = d;
      }
      return best;
    };
    for (const r of rows) {
      const a = actsOf.get(r.id);
      const lastActivityAt = latest(a);
      const scored = scorePlatformLead(
        {
          status: r.status as PlatformLeadStage,
          source: r.source,
          units: r.units,
          facilities: r.facilities,
          replied: ['email_in', 'call', 'demo', 'meeting'].some((t) => a?.has(t)),
          proposalOpens: opensOf.get(r.id) ?? 0,
          lastActivityAt,
          lastOutboundAt: latest(a, ['email_out', 'quote']),
          lastInboundAt: latest(a, ['web_form', 'email_in']),
          createdAt: r.createdAt,
        },
        now,
      );
      const value = estimatePlatformLeadValue(r, context.value);
      out.set(r.id, { score: scored.score, monthly: value?.monthly ?? null, lastActivityAt });
    }
    return out;
  }

  /** Planes, precios y ajustes para la cuota prevista y los parados (una vez por petición). */
  async insightContext(): Promise<LeadInsightContext> {
    const [plans, extra, pricing, settings] = await Promise.all([
      this.admin.subscriptionPlan.findMany({
        select: {
          slug: true,
          name: true,
          priceMonthly: true,
          maxUnits: true,
          includedUnits: true,
          isActive: true,
          isPublic: true,
        },
      }),
      this.admin.subscriptionAddon.findUnique({
        where: { slug: EXTRA_UNITS_ADDON_SLUG },
        select: { priceMonthly: true },
      }),
      platformPricing(this.admin),
      this.settings.get(),
    ]);
    return {
      value: {
        plans: plans.map((p) => ({
          slug: p.slug,
          name: p.name,
          priceMonthly: Number(p.priceMonthly),
          maxUnits: p.maxUnits,
          includedUnits: p.includedUnits,
          isActive: p.isActive,
          isPublic: p.isPublic,
        })),
        extraUnitPrice: extra ? Number(extra.priceMonthly) : null,
        pricesIncludeVat: pricing.includeVat,
        taxRate: pricing.taxRate,
      },
      stale: this.settings.staleDaysOf(settings),
      highValue: this.settings.highValueOf(settings),
    };
  }

  async toDtos(
    rows: LeadRow[],
    ctx?: LeadInsightContext,
    now = new Date(),
  ): Promise<PlatformLeadDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const slugs = [...new Set(rows.map((r) => r.planSlug).filter((s): s is string => !!s))];
    const emails = [
      ...new Set(rows.filter((r) => !r.tenantId && r.email).map((r) => r.email!.toLowerCase())),
    ];
    const [plans, owners, acts, opens, context] = await Promise.all([
      slugs.length
        ? this.admin.subscriptionPlan.findMany({
            where: { slug: { in: slugs } },
            select: { slug: true, name: true },
          })
        : [],
      emails.length
        ? this.admin.user.findMany({
            where: {
              email: { in: emails },
              role: 'owner',
              tenant: { deletedAt: null },
            },
            select: { email: true, tenant: { select: { id: true, name: true, slug: true } } },
          })
        : [],
      this.admin.platformLeadActivity.groupBy({
        by: ['leadId', 'type'],
        where: { leadId: { in: ids } },
        _max: { occurredAt: true },
      }),
      this.admin.platformQuoteOffer.groupBy({
        by: ['leadId'],
        where: { leadId: { in: ids } },
        _sum: { openCount: true },
      }),
      ctx ? Promise.resolve(ctx) : this.insightContext(),
    ]);
    const planName = new Map(plans.map((p) => [p.slug, p.name]));
    const ownerOf = new Map<string, PlatformLeadTenantRefDto>();
    for (const o of owners) {
      if (!ownerOf.has(o.email.toLowerCase())) ownerOf.set(o.email.toLowerCase(), o.tenant);
    }
    const actsOf = new Map<string, Map<string, Date>>();
    for (const a of acts) {
      if (!a.leadId || !a._max.occurredAt) continue;
      const m = actsOf.get(a.leadId) ?? new Map<string, Date>();
      m.set(a.type, a._max.occurredAt);
      actsOf.set(a.leadId, m);
    }
    const opensOf = new Map(opens.map((o) => [o.leadId ?? '', o._sum.openCount ?? 0]));
    const latest = (m: Map<string, Date> | undefined, types: readonly string[]) => {
      let best: Date | null = null;
      for (const t of types) {
        const d = m?.get(t);
        if (d && (!best || d > best)) best = d;
      }
      return best;
    };
    return rows.map((r) => {
      const a = actsOf.get(r.id);
      const lastActivityAt = r.activities[0]?.occurredAt ?? null;
      const status = r.status as PlatformLeadStage;
      const scored = scorePlatformLead(
        {
          status,
          source: r.source,
          units: r.units,
          facilities: r.facilities,
          replied: ['email_in', 'call', 'demo', 'meeting'].some((t) => a?.has(t)),
          proposalOpens: opensOf.get(r.id) ?? 0,
          lastActivityAt,
          lastOutboundAt: latest(a, ['email_out', 'quote']),
          lastInboundAt: latest(a, ['web_form', 'email_in']),
          createdAt: r.createdAt,
        },
        now,
      );
      const value = estimatePlatformLeadValue(r, context.value);
      const staleDays = r.discardedAt
        ? null
        : staleDaysOf({ status, lastActivityAt, createdAt: r.createdAt }, context.stale, now);
      return {
        id: r.id,
        status,
        source: r.source as PlatformLeadSource,
        displayName: platformLeadName(r),
        companyName: r.companyName,
        contactName: r.contactName,
        email: r.email,
        phone: r.phone,
        units: r.units,
        facilities: r.facilities,
        profile: r.profile,
        currentSoftware: r.currentSoftware,
        city: r.city,
        planSlug: r.planSlug,
        planName: r.planSlug ? (planName.get(r.planSlug) ?? null) : null,
        message: r.message,
        assignedToId: r.assignedToId,
        assignedToName: r.assignedTo?.fullName ?? null,
        tenant: r.tenant ? { id: r.tenant.id, name: r.tenant.name, slug: r.tenant.slug } : null,
        existingTenant:
          !r.tenantId && r.email ? (ownerOf.get(r.email.toLowerCase()) ?? null) : null,
        utmSource: r.utmSource,
        utmMedium: r.utmMedium,
        utmCampaign: r.utmCampaign,
        contactedAt: r.contactedAt?.toISOString() ?? null,
        interestedAt: r.interestedAt?.toISOString() ?? null,
        trialAt: r.trialAt?.toISOString() ?? null,
        customerAt: r.customerAt?.toISOString() ?? null,
        lostAt: r.lostAt?.toISOString() ?? null,
        lostReasonCode: (r.lostReasonCode as PlatformLeadLostReason | null) ?? null,
        lostReason: r.lostReason,
        firstResponseAt: r.firstResponseAt?.toISOString() ?? null,
        awaitingReplySince:
          r.awaitingReplySince?.toISOString() ??
          (r.status === 'new' && !r.firstResponseAt ? r.createdAt.toISOString() : null),
        discardedAt: r.discardedAt?.toISOString() ?? null,
        salesRepName: r.salesRep?.fullName ?? null,
        salesBatch: r.salesBatch,
        salesNew: !!r.salesRepId && !r.salesSeenAt,
        salesArchivedAt:
          r.status === 'lost' && r.salesArchivedAt ? r.salesArchivedAt.toISOString() : null,
        salesRecoverOn:
          r.status === 'lost' && r.salesArchivedAt && r.salesRecoverOn
            ? isoDate(r.salesRecoverOn)
            : null,
        doNotContact: r.doNotContact,
        accountKeptBy:
          r.tenant?.salesRep && !r.tenant.deletedAt && r.tenant.salesRep.id !== r.assignedToId
            ? { id: r.tenant.salesRep.id, name: r.tenant.salesRep.fullName }
            : null,
        lastActivityAt: lastActivityAt?.toISOString() ?? null,
        nextFollowup: r.followups[0]
          ? {
              id: r.followups[0].id,
              title: r.followups[0].title,
              dueDate: isoDate(r.followups[0].dueDate),
            }
          : null,
        score: scored.score,
        scoreFactors: scored.factors,
        estimatedMonthly: value?.monthly ?? null,
        estimatedPlanName: value?.planName ?? null,
        highValue: (value?.monthly ?? 0) >= context.highValue && context.highValue > 0,
        staleDays,
        responseDueAt:
          r.status === 'new' && !r.firstResponseAt
            ? (r.responseDueAt?.toISOString() ?? null)
            : null,
        proposalOpens: opensOf.get(r.id) ?? 0,
        discardReasonCode: (r.discardReasonCode as PlatformLeadDiscardReason | null) ?? null,
        discardReason: r.discardReason,
        mergedIntoId: r.mergedIntoId,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  private notFound() {
    return new NotFoundException({ code: 'lead_not_found', message: 'Lead no encontrado' });
  }

  async leadOrThrow(id: string) {
    const row = await this.admin.platformLead.findUnique({ where: { id } });
    if (!row || row.discardedAt) throw this.notFound();
    return row;
  }

  /** Un lead que pidió no volver a ser contactado no recibe correos ni recordatorios. */
  assertContactable(lead: { doNotContact: boolean }): void {
    if (lead.doNotContact) {
      throw new BadRequestException({
        code: 'do_not_contact',
        message: 'Pidió que no le volvamos a contactar: quita esa marca antes',
      });
    }
  }

  private async assertAssignee(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const found = await this.admin.superAdmin.findFirst({
      where: { id, isActive: true },
      select: { id: true },
    });
    if (!found) {
      throw new BadRequestException({
        code: 'invalid_assignee',
        message: 'Ese administrador no existe o está desactivado',
      });
    }
  }

  /** Otro lead (no descartado) con el mismo email o teléfono. */
  async findDuplicate(
    email: string | null,
    phone: string | null,
    exceptId?: string,
  ): Promise<{ id: string; companyName: string | null; contactName: string | null } | null> {
    if (email) {
      const byEmail = await this.admin.platformLead.findFirst({
        where: {
          discardedAt: null,
          email: { equals: email, mode: 'insensitive' },
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, companyName: true, contactName: true },
      });
      if (byEmail) return byEmail;
    }
    const tail = digits(phone).slice(-9);
    if (tail.length === 9) {
      const rows = await this.admin.$queryRaw<
        { id: string; company_name: string | null; contact_name: string | null }[]
      >`
        SELECT id, company_name, contact_name FROM platform_leads
        WHERE discarded_at IS NULL AND phone IS NOT NULL
          AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ${tail}
          ${exceptId ? Prisma.sql`AND id <> ${exceptId}::uuid` : Prisma.empty}
        ORDER BY created_at DESC LIMIT 1`;
      const r = rows[0];
      if (r) return { id: r.id, companyName: r.company_name, contactName: r.contact_name };
    }
    return null;
  }

  // ------------------------------------------------------------ escritura

  /** 409 `lead_exists` si otro lead (no descartado) tiene ese email o teléfono. */
  private async assertNoDuplicate(
    email: string | null,
    phone: string | null,
    exceptId?: string,
  ): Promise<void> {
    const dup = await this.findDuplicate(email, phone, exceptId);
    if (dup) {
      throw new ConflictException({
        code: 'lead_exists',
        message: `Ya hay un lead con ese email o teléfono: ${platformLeadName(dup)}`,
        details: { leadId: dup.id },
      });
    }
  }

  async record(
    actor: LeadActor | null | undefined,
    action: string,
    leadId: string,
    changes?: Record<string, unknown>,
  ): Promise<void> {
    if (!actor) return;
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: `admin.platform_lead.${action}`,
      targetType: 'platform_lead',
      targetId: leadId,
      ...(changes ? { changes } : {}),
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  async create(input: CreatePlatformLeadInput, actor: LeadActor): Promise<PlatformLeadDetailDto> {
    const email = clean(input.email)?.toLowerCase() ?? null;
    const phone = clean(input.phone);
    await this.assertNoDuplicate(email, phone);
    const assignedToId = input.assignedToId === undefined ? actor.superAdminId : input.assignedToId;
    await this.assertAssignee(assignedToId);
    const lead = await this.admin.platformLead.create({
      data: {
        status: 'new',
        source: input.source,
        companyName: clean(input.companyName),
        contactName: clean(input.contactName),
        email,
        phone,
        units: clean(input.units),
        facilities: clean(input.facilities),
        profile: clean(input.profile),
        currentSoftware: clean(input.currentSoftware),
        city: clean(input.city),
        planSlug: clean(input.planSlug),
        message: clean(input.message),
        assignedToId: assignedToId ?? null,
        createdById: actor.superAdminId,
      },
    });
    if (clean(input.message)) {
      await this.addActivity(lead.id, 'note', clean(input.message)!, actor.superAdminId);
    }
    await this.applyPortfolio(lead.id, assignedToId ?? null, actor.superAdminId);
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.created',
      targetType: 'platform_lead',
      targetId: lead.id,
      changes: { source: input.source },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return this.detail(lead.id);
  }

  async update(
    id: string,
    input: UpdatePlatformLeadInput,
    byId: string | null = null,
    actor?: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    const email =
      input.email !== undefined ? (clean(input.email)?.toLowerCase() ?? null) : lead.email;
    const phone = input.phone !== undefined ? clean(input.phone) : lead.phone;
    if (!email && !phone) {
      throw new BadRequestException({
        code: 'contact_required',
        message: 'Deja al menos un email o un teléfono',
      });
    }
    // Solo lo que cambia: un dato que ya estaba repetido no bloquea editar otro.
    const emailChanged = input.email !== undefined && email !== lead.email;
    const phoneChanged = input.phone !== undefined && digits(phone) !== digits(lead.phone);
    if (emailChanged || phoneChanged) {
      await this.assertNoDuplicate(emailChanged ? email : null, phoneChanged ? phone : null, id);
    }
    if (input.assignedToId !== undefined) await this.assertAssignee(input.assignedToId);
    const data: Prisma.PlatformLeadUncheckedUpdateInput = {};
    for (const key of [
      'companyName',
      'contactName',
      'units',
      'facilities',
      'profile',
      'currentSoftware',
      'city',
      'planSlug',
    ] as const) {
      if (input[key] !== undefined) data[key] = clean(input[key]);
    }
    if (input.email !== undefined) data.email = email;
    if (input.phone !== undefined) data.phone = phone;
    if (input.source) data.source = input.source;
    if (input.assignedToId !== undefined) data.assignedToId = input.assignedToId;
    await this.admin.platformLead.update({ where: { id }, data });
    const reassigned = input.assignedToId !== undefined && input.assignedToId !== lead.assignedToId;
    if (reassigned) await this.applyPortfolio(id, input.assignedToId ?? null, byId);
    const changed = AUDITED_FIELDS.filter((key) => {
      if (input[key] === undefined) return false;
      if (key === 'email') return emailChanged;
      if (key === 'phone') return phoneChanged;
      if (key === 'assignedToId') return reassigned;
      if (key === 'source') return input.source !== lead.source;
      return clean(input[key] as string | undefined) !== lead[key];
    });
    if (changed.length > 0) {
      await this.record(actor ?? (byId ? { superAdminId: byId } : null), 'updated', id, {
        fields: changed,
      });
    }
    return this.detail(id);
  }

  /**
   * La cartera de comerciales sigue a quien lo lleva en el tablero: asignarlo a
   * un comercial lo pone en su cartera (y le avisa); a otra persona o a nadie,
   * lo saca de la del comercial que lo tenía. Si su cuenta ya es cliente de un
   * comercial, la cuenta (y sus comisiones) no se mueve: solo cambia quién lo
   * trabaja en el tablero (la ficha lo avisa con `accountKeptBy`).
   */
  async applyPortfolio(
    leadId: string,
    assigneeId: string | null,
    byId: string | null,
  ): Promise<void> {
    const lead = await this.admin.platformLead.findUnique({
      where: { id: leadId },
      select: { salesRepId: true, tenant: { select: { salesRepId: true, deletedAt: true } } },
    });
    if (!lead) return;
    const rep = assigneeId
      ? await this.admin.superAdmin.findFirst({
          where: { id: assigneeId, role: 'sales', isActive: true },
          select: { id: true },
        })
      : null;
    const accountRep = lead.tenant && !lead.tenant.deletedAt ? lead.tenant.salesRepId : null;
    if (accountRep && accountRep !== rep?.id) return;
    if (rep) {
      await this.assignment.assign({ leadId, repId: rep.id, source: 'manual', byId });
    } else if (lead.salesRepId) {
      await this.assignment.assign({
        leadId,
        repId: null,
        source: 'manual',
        byId,
        endedReason: 'unassigned',
      });
    }
  }

  /** Mover a mano entre Nuevo, Contactado e Interesado (también reabre un perdido). */
  async move(
    id: string,
    input: MovePlatformLeadInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.status === 'trial' || lead.status === 'customer') {
      throw new BadRequestException({
        code: 'stage_automatic',
        message: 'Este lead ya tiene cuenta: su fase la marca su cuenta (prueba o pago)',
      });
    }
    if (lead.status === input.status) return this.detail(id);
    const now = new Date();
    await this.admin.platformLead.update({
      where: { id },
      data: {
        status: input.status,
        ...(input.status !== 'new'
          ? {
              contactedAt: lead.contactedAt ?? now,
              firstResponseAt: lead.firstResponseAt ?? now,
              awaitingReplySince: null,
            }
          : {}),
        ...(input.status === 'interested' ? { interestedAt: lead.interestedAt ?? now } : {}),
        ...(lead.status === 'lost'
          ? { lostAt: null, lostReasonCode: null, lostReason: null, ...ARCHIVE_CLEAR }
          : {}),
      },
    });
    await this.addActivity(
      id,
      'system',
      `${lead.status === 'lost' ? 'Reabierto' : 'Pasa'} a ${PLATFORM_LEAD_STAGE_LABELS[input.status]}`,
      actor.superAdminId,
    );
    await this.record(actor, lead.status === 'lost' ? 'reopened' : 'moved', id, {
      from: lead.status,
      to: input.status,
    });
    return this.detail(id);
  }

  /**
   * Al perderse, lo que tenía pendiente ya no toca (el «volver a contactar»
   * que se crea con la pérdida va después).
   */
  async closePendingFollowups(leadId: string, now = new Date()): Promise<number> {
    const { count } = await this.admin.platformLeadFollowup.updateMany({
      where: { leadId, status: 'pending' },
      data: { status: 'done', completedAt: now },
    });
    return count;
  }

  // --------------------------------------------------------------- archivados

  /** Fecha de volver a intentarlo: que exista y sea posterior a hoy (hora de España). */
  assertRecoverDay(value: string, now = new Date()): void {
    if (!isRealIsoDay(value)) {
      throw new BadRequestException({ code: 'invalid_date', message: 'Esa fecha no existe' });
    }
    if (value <= madridToday(now)) {
      throw new BadRequestException({
        code: 'date_not_future',
        message: 'Elige un día a partir de mañana para volver a intentarlo',
      });
    }
  }

  /** La fecha de volver a intentarlo que toca por el motivo (Reglas del equipo). */
  async proposedRecoverOn(reason: LostReason, now = new Date()): Promise<string> {
    const settings = await this.assignment.settings();
    return proposeRecoverOn(madridToday(now), reason, parseRecoverMonths(settings.recoverMonths));
  }

  /**
   * Deja un perdido archivado en la cartera de su comercial: sigue siendo suyo,
   * sin recordatorios ni cadencia, con la fecha de volver a intentarlo (o
   * «No volver a contactar»). Queda anotado para medir sus recuperaciones.
   */
  async archiveForRep(
    leadId: string,
    a: {
      repId: string;
      tenantId: string | null;
      kind: 'prospect' | 'client';
      reasonCode: LostReason;
      recoverOn: string | null | undefined;
      doNotContact: boolean;
      byId: string | null;
      now: Date;
    },
  ): Promise<void> {
    const recoverOn = a.doNotContact
      ? null
      : a.recoverOn === undefined
        ? await this.proposedRecoverOn(a.reasonCode, a.now)
        : a.recoverOn;
    const recoverDate = recoverOn ? new Date(`${recoverOn}T00:00:00Z`) : null;
    await this.admin.platformLead.update({
      where: { id: leadId },
      data: {
        salesArchivedAt: a.now,
        salesRecoverOn: recoverDate,
        salesRecoverNotifiedAt: null,
        doNotContact: a.doNotContact,
        ...(a.doNotContact ? { sequenceOptOut: true } : {}),
      },
    });
    await this.admin.salesRecovery.create({
      data: {
        leadId,
        repId: a.repId,
        tenantId: a.tenantId,
        kind: a.kind,
        reasonCode: a.reasonCode,
        archivedAt: a.now,
        recoverOn: recoverDate,
      },
    });
    await this.stopSalesCadence(leadId, a.now);
    if (a.doNotContact) await this.stopSequence(leadId, 'manual');
    await this.addActivity(
      leadId,
      'system',
      a.doNotContact
        ? 'Archivado: no volver a contactar'
        : recoverOn
          ? `Archivado: volver a intentarlo el ${dayLabel(recoverOn)}`
          : 'Archivado sin fecha para volver a intentarlo',
      a.byId,
    );
  }

  /** Para la cadencia del comercial (sus seguimientos ya se cerraron o se cierran aparte). */
  async stopSalesCadence(leadId: string, now = new Date()): Promise<void> {
    const active = await this.admin.salesCadenceEnrollment.findMany({
      where: { leadId, status: 'active' },
      select: { id: true, followupIds: true },
    });
    for (const e of active) {
      await this.admin.platformLeadFollowup.updateMany({
        where: { id: { in: e.followupIds }, status: 'pending' },
        data: { status: 'done', completedAt: now },
      });
    }
    if (active.length) {
      await this.admin.salesCadenceEnrollment.updateMany({
        where: { id: { in: active.map((e) => e.id) } },
        data: { status: 'stopped', finishedAt: now },
      });
    }
  }

  /**
   * Paga tras archivarse: la última recuperación abierta queda ganada (un
   * cliente que vuelve cuenta como recuperado aunque nadie pulsara
   * «Recuperar»; un prospecto, solo si su comercial lo recuperó).
   */
  private async markRecoveryWon(leadId: string, tenantId: string, now: Date): Promise<void> {
    const open = await this.admin.salesRecovery.findFirst({
      where: { leadId, wonAt: null },
      orderBy: { archivedAt: 'desc' },
    });
    if (!open) return;
    if (open.kind !== 'client' && !open.recoveredAt) return;
    // El primer cobro después de archivarse.
    const paid = await this.admin.tenantSubscriptionPayment.findFirst({
      where: {
        tenantId,
        status: 'paid',
        amount: { gt: 0 },
        OR: [
          { paidAt: { gt: open.archivedAt } },
          { paidAt: null, createdAt: { gt: open.archivedAt } },
        ],
      },
      orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
      select: { paidAt: true, createdAt: true },
    });
    const wonAt = paid ? (paid.paidAt ?? paid.createdAt) : now;
    await this.admin.salesRecovery.update({
      where: { id: open.id },
      data: { wonAt, recoveredAt: open.recoveredAt ?? wonAt },
    });
  }

  /**
   * Perdido. Si es de un comercial, queda archivado en su cartera con la fecha
   * de volver a intentarlo (la que toca por el motivo si no se indica) o como
   * «No volver a contactar».
   */
  async lose(
    id: string,
    input: LosePlatformLeadInput,
    actor: LeadActor,
    archive: LeadArchiveOptions = {},
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.status === 'customer') {
      throw new BadRequestException({
        code: 'lead_is_customer',
        message: 'Ya es cliente: si se da de baja, se gestiona desde su ficha de tenant',
      });
    }
    const recontactOn = clean(input.recontactOn);
    if (recontactOn) assertUpcomingDay(recontactOn);
    if (archive.recoverOn) this.assertRecoverDay(archive.recoverOn);
    const now = new Date();
    await this.admin.platformLead.update({
      where: { id },
      data: {
        status: 'lost',
        lostAt: now,
        lostReasonCode: input.reasonCode,
        lostReason: clean(input.reason),
        awaitingReplySince: null,
        ...ARCHIVE_CLEAR,
      },
    });
    const closed = await this.closePendingFollowups(id, now);
    await this.stopSequence(id, 'stage');
    await this.addActivity(
      id,
      'system',
      `Perdido: ${PLATFORM_LEAD_LOST_REASON_LABELS[input.reasonCode]}${clean(input.reason) ? ` — ${clean(input.reason)}` : ''}`,
      actor.superAdminId,
    );
    if (lead.salesRepId) {
      await this.archiveForRep(id, {
        repId: lead.salesRepId,
        tenantId: lead.tenantId,
        kind: 'prospect',
        reasonCode: input.reasonCode,
        recoverOn: archive.recoverOn,
        doNotContact: archive.doNotContact ?? false,
        byId: actor.superAdminId,
        now,
      });
    }
    if (recontactOn) {
      await this.admin.platformLeadFollowup.create({
        data: {
          leadId: id,
          superAdminId: actor.superAdminId,
          assignedToId: lead.assignedToId ?? actor.superAdminId,
          title: 'Volver a contactar',
          note: clean(input.reason),
          dueDate: new Date(`${recontactOn}T00:00:00Z`),
        },
      });
    }
    await this.record(actor, 'lost', id, {
      from: lead.status,
      reasonCode: input.reasonCode,
      closedFollowups: closed,
      recontact: !!recontactOn,
    });
    return this.detail(id);
  }

  /** Reabre un perdido: si tiene cuenta, su fase la marca la cuenta; si no, «Contactado». */
  async reopen(id: string, actor: LeadActor): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.status !== 'lost') return this.detail(id);
    if (lead.tenantId) {
      await this.admin.platformLead.update({
        where: { id },
        data: {
          status: 'trial',
          lostAt: null,
          lostReasonCode: null,
          lostReason: null,
          ...ARCHIVE_CLEAR,
        },
      });
      await this.addActivity(id, 'system', 'Reabierto', actor.superAdminId);
      await this.record(actor, 'reopened', id, { from: 'lost', to: 'trial' });
      await this.syncFromTenants();
      return this.detail(id);
    }
    return this.move(id, { status: 'contacted' }, actor);
  }

  /** «No es un lead»: sale del tablero y de las cifras (spam, soporte, proveedores…). */
  async discard(
    id: string,
    actor: LeadActor,
    input: {
      reasonCode: Exclude<PlatformLeadDiscardReason, 'merged'>;
      reason?: string | null | undefined;
    } = {
      reasonCode: 'other',
    },
  ): Promise<void> {
    await this.leadOrThrow(id);
    await this.assertNotSalesClient(id);
    await this.admin.platformLead.update({
      where: { id },
      data: {
        discardedAt: new Date(),
        discardReasonCode: input.reasonCode,
        discardReason: clean(input.reason),
      },
    });
    await this.stopSequence(id, 'discarded');
    await this.addActivity(
      id,
      'system',
      `No es un lead: ${PLATFORM_LEAD_DISCARD_REASON_LABELS[input.reasonCode]}${clean(input.reason) ? ` — ${clean(input.reason)}` : ''}`,
      actor.superAdminId,
    );
    await this.record(actor, 'discarded', id, { reasonCode: input.reasonCode });
  }

  /** Recupera un descartado: vuelve al tablero tal como estaba. */
  async restore(id: string, actor: LeadActor): Promise<PlatformLeadDetailDto> {
    const lead = await this.admin.platformLead.findUnique({ where: { id } });
    if (!lead) throw this.notFound();
    if (!lead.discardedAt) return this.detail(id);
    // Mientras estaba fuera pudo entrar otro con el mismo email o teléfono.
    await this.assertNoDuplicate(lead.email, lead.phone, id);
    if (lead.mergedIntoId) {
      throw new ConflictException({
        code: 'lead_merged',
        message: 'Se fusionó con otro lead: lo que tenía está en ese lead',
        details: { leadId: lead.mergedIntoId },
      });
    }
    await this.admin.platformLead.update({
      where: { id },
      data: { discardedAt: null, discardReasonCode: null, discardReason: null },
    });
    await this.addActivity(id, 'system', 'Recuperado: vuelve a ser un lead', actor.superAdminId);
    await this.record(actor, 'restored', id);
    return this.detail(id);
  }

  async remove(id: string, actor: LeadActor): Promise<void> {
    const lead = await this.admin.platformLead.findUnique({ where: { id }, select: { id: true } });
    if (!lead) throw this.notFound();
    await this.assertNotSalesClient(id);
    await this.admin.$transaction([
      // Sus propuestas que aún no son de ningún tenant se van con él.
      this.admin.platformQuoteOffer.deleteMany({ where: { leadId: id, tenantId: null } }),
      this.admin.platformLead.delete({ where: { id } }),
    ]);
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.deleted',
      targetType: 'platform_lead',
      targetId: id,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  /**
   * El lead de la cuenta de un cliente que lleva un comercial es su ficha: sin
   * él, el comercial pierde la cuenta y sus contadores. Antes hay que quitarle
   * el comercial.
   */
  async assertNotSalesClient(id: string): Promise<void> {
    const lead = await this.admin.platformLead.findUnique({
      where: { id },
      select: { tenant: { select: { salesRepId: true, deletedAt: true } } },
    });
    if (lead?.tenant && lead.tenant.salesRepId && !lead.tenant.deletedAt) {
      throw new ConflictException({
        code: 'lead_is_sales_client',
        message: 'Es la cuenta de un cliente de un comercial: quítale antes el comercial',
      });
    }
  }

  // ---------------------------------------------------------- actividad

  async addActivity(
    leadId: string,
    type: PlatformLeadActivityType,
    content: string,
    superAdminId: string | null,
    extra: { subject?: string | null; occurredAt?: Date; attachments?: StoredAttachment[] } = {},
  ): Promise<void> {
    await this.admin.platformLeadActivity.create({
      data: {
        leadId,
        type,
        content,
        superAdminId,
        subject: extra.subject ?? null,
        ...(extra.attachments?.length
          ? { attachments: extra.attachments as unknown as Prisma.InputJsonValue }
          : {}),
        ...(extra.occurredAt ? { occurredAt: extra.occurredAt } : {}),
      },
    });
    // Si contesta (o se habla con él), los correos automáticos ya no tocan.
    if (PLATFORM_LEAD_REPLY_TYPES.includes(type)) await this.sequences.stop(leadId, 'replied');
  }

  /** Para la secuencia de correos (al salir de las fases abiertas, descartarlo…). */
  async stopSequence(leadId: string, reason: SequenceStopReason): Promise<void> {
    await this.sequences.stop(leadId, reason);
  }

  /**
   * Marca que se le ha respondido (y saca de «Nuevo»), con la fecha en que se
   * hizo (una llamada anotada más tarde cuenta desde cuando fue). Una respuesta
   * anterior a su último mensaje no cierra la espera de ese mensaje.
   */
  async markResponded(leadId: string, at = new Date()): Promise<void> {
    const lead = await this.admin.platformLead.findUnique({
      where: { id: leadId },
      select: {
        status: true,
        createdAt: true,
        firstResponseAt: true,
        contactedAt: true,
        awaitingReplySince: true,
      },
    });
    if (!lead) return;
    // Nunca antes de que entrase (una nota de una llamada de antes de darlo de alta).
    const when = at.getTime() < lead.createdAt.getTime() ? lead.createdAt : at;
    const answersWait =
      !lead.awaitingReplySince || lead.awaitingReplySince.getTime() <= when.getTime();
    const data: Prisma.PlatformLeadUncheckedUpdateInput = {};
    if (!lead.firstResponseAt) {
      data.firstResponseAt = when;
      data.responseDueAt = null;
    }
    if (answersWait && lead.awaitingReplySince) data.awaitingReplySince = null;
    if (answersWait && lead.status === 'new') {
      data.status = 'contacted';
      data.contactedAt = lead.contactedAt ?? when;
    }
    if (Object.keys(data).length > 0) {
      await this.admin.platformLead.update({ where: { id: leadId }, data });
    }
  }

  async createActivity(
    id: string,
    input: CreatePlatformLeadActivityInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    await this.leadOrThrow(id);
    const at = activityDate(input.occurredAt);
    await this.addActivity(id, input.type, input.content, actor.superAdminId, { occurredAt: at });
    if (CONTACT_ACTIVITY_TYPES.has(input.type)) await this.markResponded(id, at);
    return this.detail(id);
  }

  async deleteActivity(
    id: string,
    activityId: string,
    actor?: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const activity = await this.admin.platformLeadActivity.findFirst({
      where: { id: activityId, leadId: id },
      select: { type: true },
    });
    if (!activity) {
      throw new NotFoundException({
        code: 'activity_not_found',
        message: 'Actividad no encontrada',
      });
    }
    if (!MANUAL_ACTIVITY_TYPES.has(activity.type)) {
      throw new BadRequestException({
        code: 'activity_locked',
        message: 'Los correos, mensajes y avisos automáticos no se borran',
      });
    }
    await this.admin.platformLeadActivity.delete({ where: { id: activityId } });
    await this.record(actor, 'activity_deleted', id, { type: activity.type });
    return this.detail(id);
  }

  // -------------------------------------------------------- seguimientos

  async createFollowup(
    id: string,
    input: CreatePlatformLeadFollowupInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    this.assertContactable(lead);
    const assignedToId =
      input.assignedToId === undefined
        ? (lead.assignedToId ?? actor.superAdminId)
        : input.assignedToId;
    await this.assertAssignee(assignedToId);
    assertUpcomingDay(input.dueDate);
    const followup = await this.admin.platformLeadFollowup.create({
      data: {
        leadId: id,
        superAdminId: actor.superAdminId,
        assignedToId: assignedToId ?? null,
        title: input.title,
        note: clean(input.note),
        dueDate: new Date(`${input.dueDate}T00:00:00Z`),
      },
    });
    await this.record(actor, 'followup_created', id, {
      followupId: followup.id,
      dueDate: input.dueDate,
    });
    return this.detail(id);
  }

  /** Pendientes de todos los leads, por fecha (`mine`: los de ese super admin). */
  async pendingFollowups(mine: string | null = null): Promise<PlatformLeadFollowupDto[]> {
    const rows = await this.admin.platformLeadFollowup.findMany({
      where: {
        status: 'pending',
        lead: { discardedAt: null },
        ...(mine ? { assignedToId: mine } : {}),
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      take: 300,
      include: FOLLOWUP_INCLUDE,
    });
    return rows.map(toLeadFollowupDto);
  }

  /** Los de hoy o atrasados (para «Hoy»). */
  async followupsDue(now = new Date()): Promise<PlatformLeadFollowupDto[]> {
    const today = madridToday(now);
    return (await this.pendingFollowups()).filter((f) => f.dueDate <= today);
  }

  async updateFollowup(
    followupId: string,
    input: UpdatePlatformLeadFollowupInput,
    actor?: LeadActor,
  ): Promise<PlatformLeadFollowupDto> {
    const row = await this.admin.platformLeadFollowup.findUnique({ where: { id: followupId } });
    if (!row) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    if (input.assignedToId !== undefined) await this.assertAssignee(input.assignedToId);
    if (input.dueDate) assertUpcomingDay(input.dueDate);
    const updated = await this.admin.platformLeadFollowup.update({
      where: { id: followupId },
      data: {
        ...(input.status
          ? { status: input.status, completedAt: input.status === 'done' ? new Date() : null }
          : {}),
        ...(input.dueDate ? { dueDate: new Date(`${input.dueDate}T00:00:00Z`) } : {}),
        ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      },
      include: FOLLOWUP_INCLUDE,
    });
    await this.record(actor, 'followup_updated', row.leadId, {
      followupId,
      fields: Object.keys(input),
    });
    return toLeadFollowupDto(updated);
  }

  async deleteFollowup(followupId: string, actor?: LeadActor): Promise<void> {
    const row = await this.admin.platformLeadFollowup.findUnique({
      where: { id: followupId },
      select: { leadId: true },
    });
    const { count } = await this.admin.platformLeadFollowup.deleteMany({
      where: { id: followupId },
    });
    if (count === 0 || !row) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    await this.record(actor, 'followup_deleted', row.leadId, { followupId });
  }

  // --------------------------------------------------------------- correo

  async sendEmail(
    id: string,
    input: SendPlatformLeadEmailInput,
    actor: LeadActor,
    sender?: LeadEmailSender,
    /** Otra dirección (p. ej. la del propietario de su cuenta). */
    to?: { email: string; name: string | null },
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    this.assertContactable(lead);
    const email = to?.email ?? lead.email;
    if (!email) {
      throw new BadRequestException({
        code: 'lead_without_email',
        message: 'Este lead no tiene email',
      });
    }
    const attachments = await this.checkAttachments(id, input.attachments);
    await this.deliver(
      id,
      email,
      to ? to.name : lead.contactName,
      input.subject,
      input.body,
      sender,
      attachments,
    );
    await this.addActivity(id, 'email_out', input.body, actor.superAdminId, {
      subject: input.subject,
      attachments,
    });
    await this.markResponded(id);
    if (!to) await this.sequences.autoStart(id, actor.superAdminId);
    await this.record(actor, 'email_sent', id, {
      to: to ? 'account_owner' : 'lead',
      attachments: attachments.length,
    });
    return this.detail(id);
  }

  private async deliver(
    leadId: string,
    to: string,
    name: string | null,
    subject: string,
    markdown: string,
    sender?: LeadEmailSender,
    attachments?: StoredAttachment[],
  ): Promise<void> {
    await this.mail.send({
      leadId,
      to,
      name,
      subject,
      markdown,
      sender,
      ...(attachments?.length ? { attachments } : {}),
    });
  }

  /** URL para subir un adjunto de un correo a este lead (imagen o PDF, 10 MB). */
  async attachmentUploadUrl(id: string, mimeType: MessageAttachmentInput['mimeType']) {
    await this.leadOrThrow(id);
    return requestAttachmentUpload(this.files, this.attachmentPrefix(id), mimeType);
  }

  private attachmentPrefix(leadId: string): string {
    return `platform/leads/${leadId}/`;
  }

  private async checkAttachments(
    leadId: string,
    list: MessageAttachmentInput[] | undefined,
  ): Promise<StoredAttachment[]> {
    if (!list?.length) return [];
    if (list.length > PLATFORM_LEAD_MAX_ATTACHMENTS) {
      throw new BadRequestException({
        code: 'too_many_attachments',
        message: `Como mucho ${PLATFORM_LEAD_MAX_ATTACHMENTS} adjuntos`,
      });
    }
    const checked = await Promise.all(
      list.map((a) => assertAttachment(this.files, this.attachmentPrefix(leadId), a)),
    );
    return checked.map((c) => ({
      key: c.attachmentKey,
      mimeType: c.attachmentMime,
      filename: c.attachmentName,
    }));
  }

  private async activityAttachments(raw: Prisma.JsonValue) {
    const list = Array.isArray(raw) ? (raw as unknown as StoredAttachment[]) : [];
    if (list.length === 0) return [];
    return attachmentsDto(this.files, {
      attachmentKey: list[0]!.key,
      attachmentMime: list[0]!.mimeType,
      attachmentName: list[0]!.filename,
      extraAttachments: list.slice(1),
    });
  }

  // -------------------------------------------------------------- cuenta

  /** Une el lead a un tenant que ya existe (se registró por su cuenta). */
  async link(id: string, tenantId: string, actor: LeadActor): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.tenantId && lead.tenantId !== tenantId) {
      throw new ConflictException({
        code: 'lead_already_linked',
        message: 'Este lead ya tiene una cuenta vinculada',
      });
    }
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true, platformLead: { select: { id: true } } },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if (tenant.platformLead && tenant.platformLead.id !== id) {
      throw new ConflictException({
        code: 'tenant_already_linked',
        message: 'Ese tenant ya es de otro lead',
        details: { leadId: tenant.platformLead.id },
      });
    }
    await this.applyLink(id, tenantId, actor.superAdminId, 'manual');
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.linked',
      targetType: 'platform_lead',
      targetId: id,
      targetTenantId: tenantId,
    });
    return this.detail(id);
  }

  /**
   * Vincula y pone la fase según la cuenta (cliente si ya ha pagado, en prueba
   * si no), pasa al tenant sus propuestas y deja en la ficha del tenant el
   * enlace al historial del lead.
   */
  private async applyLink(
    leadId: string,
    tenantId: string,
    superAdminId: string | null,
    how: 'manual' | 'signup' | 'admin',
  ): Promise<void> {
    const [lead, tenant, paid] = await Promise.all([
      this.admin.platformLead.findUniqueOrThrow({ where: { id: leadId } }),
      this.admin.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, slug: true },
      }),
      this.firstPaidAt([tenantId]),
    ]);
    const now = new Date();
    const paidAt = paid.get(tenantId) ?? null;
    await this.admin.platformLead.update({
      where: { id: leadId },
      data: {
        tenantId,
        status: paidAt ? 'customer' : 'trial',
        trialAt: lead.trialAt ?? now,
        ...(paidAt ? { customerAt: lead.customerAt ?? paidAt } : {}),
        lostAt: null,
        lostReasonCode: null,
        lostReason: null,
      },
    });
    await this.admin.platformQuoteOffer.updateMany({
      where: { leadId, tenantId: null },
      data: { tenantId },
    });
    // Ya tiene cuenta: los correos de «si no contesta» ya no tocan.
    await this.stopSequence(leadId, 'stage');
    const text =
      how === 'signup'
        ? `Se ha registrado: cuenta «${tenant.name}» (${tenant.slug})`
        : how === 'admin'
          ? `Cuenta creada desde el panel: «${tenant.name}» (${tenant.slug})`
          : `Vinculado a la cuenta «${tenant.name}» (${tenant.slug})`;
    await this.addActivity(leadId, how === 'manual' ? 'system' : 'signup', text, superAdminId);
    const source = PLATFORM_LEAD_SOURCE_LABELS[lead.source as PlatformLeadSource] ?? lead.source;
    await this.interactions
      .create({
        tenantId,
        superAdminId,
        input: {
          type: 'note',
          content: `Viene del lead «${platformLeadName(lead)}» (origen: ${source}). Lo hablado antes de tener cuenta está en su ficha de lead.`,
        },
        link: `/admin/leads?lead=${leadId}`,
      })
      .catch((err: unknown) =>
        this.logger.warn(`Nota del lead en el tenant ${tenantId}: ${String(err)}`),
      );
  }

  /** Crea su cuenta (el alta de tenant de siempre) y la vincula al lead. */
  async createTenant(
    id: string,
    input: AdminCreateTenantInput,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (lead.tenantId) {
      throw new ConflictException({
        code: 'lead_already_linked',
        message: 'Este lead ya tiene una cuenta vinculada',
      });
    }
    const created = await this.tools.createTenant(
      input,
      {
        superAdminId: actor.superAdminId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
      { leadId: id },
    );
    // Por si el aviso del alta no llegó a vincularlo.
    const after = await this.admin.platformLead.findUnique({
      where: { id },
      select: { tenantId: true },
    });
    if (!after?.tenantId) await this.applyLink(id, created.tenantId, actor.superAdminId, 'admin');
    if (input.planSlug && !lead.planSlug) {
      await this.admin.platformLead.update({ where: { id }, data: { planSlug: input.planSlug } });
    }
    return this.detail(id);
  }

  // ----------------------------------------------------------- propuesta

  async sendQuote(
    id: string,
    input: SendAdminQuoteInput,
    actor: LeadActor,
    sender?: LeadEmailSender,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    this.assertContactable(lead);
    const meta = {
      superAdminId: actor.superAdminId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    };
    let summary: string;
    let planSlug: string | null = null;
    if (lead.tenantId) {
      // Ya tiene cuenta: la propuesta de siempre, a sus propietarios.
      const res = await this.quotes.send(lead.tenantId, input, meta, sender);
      summary = quoteSummary(res.quote);
    } else {
      if (!lead.email) {
        throw new BadRequestException({
          code: 'lead_without_email',
          message: 'Este lead no tiene email',
        });
      }
      const { quote, registerUrl, trackedUrl, offerId } = await this.quotes.createLeadOffer(
        { id, email: lead.email, companyName: lead.companyName, contactName: lead.contactName },
        input,
        actor.superAdminId,
      );
      summary = quoteSummary(quote);
      const money = (n: number) =>
        n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
      const period = quote.cycle === 'yearly' ? 'al año' : 'al mes';
      const hello = lead.contactName?.trim().split(/\s+/)[0];
      const body = [
        `Hola${hello ? ` ${hello}` : ''}:`,
        '',
        ...(input.message ? [input.message, ''] : []),
        `Esta es la propuesta de TrasterOS${lead.companyName ? ` para ${lead.companyName}` : ''}:`,
        '',
        ...quote.lines.map((l) => `- ${l.label}: ${money(l.amount)}`),
        ...(quote.discount > 0
          ? [`- Descuento (${quote.couponCode}): -${money(quote.discount)}`]
          : []),
        '',
        `Base: ${money(quote.base)} · IVA (${quote.taxRate} %): ${money(quote.vat)}`,
        `**Total: ${money(quote.total)} ${period}**${quote.cycle === 'yearly' ? ` (${money(quote.monthlyEquivalent)} al mes)` : ''}`,
        '',
        'Para empezar, crea tu cuenta (tienes la prueba gratis) y, cuando quieras contratar, la propuesta te estará esperando en «Suscripción».',
        '',
        `[[boton: Crear mi cuenta | ${trackedUrl ?? registerUrl}]]`,
        '',
        'Si tienes dudas, responde a este correo.',
        '',
        sender?.signature ?? 'El equipo de TrasterOS',
      ].join('\n');
      try {
        await this.deliver(
          id,
          lead.email,
          lead.contactName,
          `Tu propuesta de TrasterOS: ${money(quote.total)} ${period}`,
          body,
          sender,
        );
      } catch (err) {
        // Sin correo no hay propuesta: no se queda una oferta que nadie ha recibido.
        await this.admin.platformQuoteOffer.deleteMany({ where: { id: offerId } });
        throw err;
      }
      await this.audit.record({
        superAdminId: actor.superAdminId,
        action: 'admin.platform_lead.quote_sent',
        targetType: 'platform_lead',
        targetId: id,
        changes: { planId: input.planId, cycle: input.cycle, total: quote.total },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
      if (input.followupDays > 0) {
        await this.admin.platformLeadFollowup.create({
          data: {
            leadId: id,
            superAdminId: actor.superAdminId,
            assignedToId: lead.assignedToId ?? actor.superAdminId,
            title: 'Llamar por la propuesta',
            dueDate: new Date(
              `${isoDate(new Date(Date.now() + input.followupDays * DAY))}T00:00:00Z`,
            ),
          },
        });
      }
    }
    const plan = await this.admin.subscriptionPlan.findUnique({
      where: { id: input.planId },
      select: { slug: true },
    });
    planSlug = plan?.slug ?? null;
    await this.addActivity(
      id,
      'quote',
      `${summary}${input.message ? `\n\n${input.message}` : ''}`,
      actor.superAdminId,
    );
    const now = new Date();
    await this.admin.platformLead.updateMany({
      where: { id, status: { in: ['new', 'contacted'] } },
      data: {
        status: 'interested',
        interestedAt: now,
        contactedAt: lead.contactedAt ?? now,
      },
    });
    await this.admin.platformLead.update({
      where: { id },
      data: {
        firstResponseAt: lead.firstResponseAt ?? now,
        responseDueAt: null,
        ...(planSlug ? { planSlug } : {}),
      },
    });
    await this.sequences.autoStart(id, actor.superAdminId);
    return this.detail(id);
  }

  // ------------------------------------------------- entradas automáticas

  /** Un mensaje del formulario de la web: lead nuevo, o se suma al que ya hay. */
  async ingestContact(e: PlatformLeadInboundEvent): Promise<string> {
    const email = e.email.trim().toLowerCase();
    const existing = await this.findDuplicate(email, e.phone);
    const now = new Date();
    if (existing) {
      const lead = await this.admin.platformLead.findUniqueOrThrow({ where: { id: existing.id } });
      await this.admin.platformLead.update({
        where: { id: lead.id },
        data: {
          companyName: lead.companyName ?? clean(e.company),
          contactName: lead.contactName ?? clean(e.name),
          email: lead.email ?? email,
          phone: lead.phone ?? clean(e.phone),
          units: lead.units ?? clean(e.units),
          profile: lead.profile ?? clean(e.profile),
          // Un perdido que vuelve a escribir se atiende de nuevo: el aviso de
          // «sin atender» y «Hoy» cuentan desde este mensaje (la primera
          // respuesta de antes se queda como histórico).
          ...(lead.status === 'lost' && !lead.tenantId
            ? {
                status: 'new',
                lostAt: null,
                lostReasonCode: null,
                lostReason: null,
                unattendedNotifiedAt: null,
                awaitingReplySince: now,
              }
            : {}),
        },
      });
      await this.addActivity(lead.id, 'web_form', e.message, null, { occurredAt: now });
      return lead.id;
    }
    const lead = await this.admin.platformLead.create({
      data: {
        status: 'new',
        source: e.source,
        companyName: clean(e.company),
        contactName: clean(e.name),
        email,
        phone: clean(e.phone),
        units: clean(e.units),
        profile: clean(e.profile),
        message: e.message,
        utmSource: clean(e.utmSource),
        utmMedium: clean(e.utmMedium),
        utmCampaign: clean(e.utmCampaign),
      },
    });
    await this.addActivity(lead.id, 'web_form', e.message, null, { occurredAt: now });
    return lead.id;
  }

  /**
   * Se ha creado la cuenta de un tenant: si venía de un lead (el de la ficha o
   * uno abierto con su email) se vincula; si no, entra como lead nuevo en
   * «En prueba».
   */
  async ingestTenant(e: PlatformTenantRegisteredEvent): Promise<void> {
    const already = await this.admin.platformLead.findUnique({ where: { tenantId: e.tenantId } });
    if (already) return;
    const email = e.email.trim().toLowerCase();
    let lead = e.leadId
      ? await this.admin.platformLead.findFirst({
          where: { id: e.leadId, tenantId: null, discardedAt: null },
        })
      : null;
    if (!lead) {
      lead = await this.admin.platformLead.findFirst({
        where: {
          tenantId: null,
          discardedAt: null,
          email: { equals: email, mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (lead) {
      await this.applyLink(
        lead.id,
        e.tenantId,
        e.superAdminId,
        e.source === 'admin' ? 'admin' : 'signup',
      );
      if (!lead.utmSource && (e.utmSource || e.utmCampaign)) {
        await this.admin.platformLead.update({
          where: { id: lead.id },
          data: {
            utmSource: clean(e.utmSource),
            utmMedium: clean(e.utmMedium),
            utmCampaign: clean(e.utmCampaign),
          },
        });
      }
      if (e.source === 'signup') {
        await this.platform.notify({
          type: 'platform_lead.signed_up',
          title: `${platformLeadName(lead)} se ha registrado`,
          body: `Ha creado la cuenta «${e.tenantName}». Ya está en prueba.`,
          link: `/admin/leads?lead=${lead.id}`,
        });
      }
      return;
    }
    const now = new Date();
    const created = await this.admin.platformLead.create({
      data: {
        status: 'trial',
        source: e.source === 'admin' ? 'admin' : 'signup',
        companyName: clean(e.tenantName),
        contactName: clean(e.fullName),
        email,
        tenantId: e.tenantId,
        trialAt: now,
        assignedToId: e.superAdminId,
        createdById: e.superAdminId,
        utmSource: clean(e.utmSource),
        utmMedium: clean(e.utmMedium),
        utmCampaign: clean(e.utmCampaign),
      },
    });
    await this.addActivity(
      created.id,
      'signup',
      e.source === 'admin'
        ? `Cuenta creada desde el panel: «${e.tenantName}»`
        : `Se ha registrado en la web: «${e.tenantName}»`,
      e.superAdminId,
    );
  }

  // ------------------------------------------------ fases automáticas

  private async firstPaidAt(tenantIds: string[]): Promise<Map<string, Date>> {
    if (tenantIds.length === 0) return new Map();
    const rows = await this.admin.tenantSubscriptionPayment.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: 'paid', amount: { gt: 0 } },
      _min: { paidAt: true, createdAt: true },
    });
    return new Map(
      rows.map((r) => [r.tenantId, r._min.paidAt ?? r._min.createdAt ?? new Date()] as const),
    );
  }

  /** Tenants con un cobro de la cuota en marcha: aún puede acabar pagando. */
  private async tenantsWithChargeInFlight(tenantIds: string[]): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set();
    const [sepa, redsys, pending] = await Promise.all([
      this.admin.platformSepaRemittanceItem.findMany({
        where: {
          tenantId: { in: tenantIds },
          itemStatus: 'pending',
          remittance: { status: { not: 'cancelled' } },
        },
        select: { tenantId: true },
      }),
      this.admin.platformRedsysOrder.findMany({
        where: { tenantId: { in: tenantIds }, status: 'charging' },
        select: { tenantId: true },
      }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: { tenantId: { in: tenantIds }, status: { in: ['pending', 'processing'] } },
        select: { tenantId: true },
      }),
    ]);
    return new Set([...sepa, ...redsys, ...pending].map((r) => r.tenantId));
  }

  /**
   * Las fases que marca la cuenta, cada 15 minutos:
   *  - «Cliente» a quien ya ha pagado (también al que se dio de baja y vuelve).
   *  - «Perdido» (no contrató tras la prueba) a quien acabó la prueba sin
   *    pagar: solo con la cuenta en solo lectura (o de baja), sin un cobro en
   *    marcha y pasados unos días del fin de la prueba; con un seguimiento para
   *    volver a llamarle.
   *  - «Perdido» (cliente que se dio de baja) al cliente cuya cuenta se canceló,
   *    se suspendió o se anonimizó.
   * Idempotente: cada cambio solo se aplica desde la fase anterior.
   */
  async syncFromTenants(
    now = new Date(),
  ): Promise<{ customers: number; lost: number; churned: number }> {
    const candidates = await this.admin.platformLead.findMany({
      where: {
        discardedAt: null,
        tenantId: { not: null },
        status: { in: ['new', 'contacted', 'interested', 'trial', 'customer', 'lost'] },
      },
      select: {
        id: true,
        tenantId: true,
        status: true,
        lostReasonCode: true,
        assignedToId: true,
        salesRepId: true,
        tenant: {
          select: {
            name: true,
            trialEndedAt: true,
            deletedAt: true,
            status: true,
            billingExempt: true,
            subscription: {
              select: { status: true, plan: { select: { priceMonthly: true } } },
            },
          },
        },
      },
    });
    const paid = await this.firstPaidAt(candidates.map((c) => c.tenantId!));
    const graceLimit = now.getTime() - PLATFORM_LEAD_TRIAL_LOST_GRACE_DAYS * DAY;
    const trialEnded = candidates.filter((c) => {
      const t = c.tenant;
      return (
        c.status === 'trial' &&
        !paid.has(c.tenantId!) &&
        t?.trialEndedAt &&
        t.trialEndedAt.getTime() < graceLimit
      );
    });
    const inFlight = await this.tenantsWithChargeInFlight(trialEnded.map((c) => c.tenantId!));
    let customers = 0;
    let lost = 0;
    let churned = 0;
    for (const c of candidates) {
      const t = c.tenant;
      const paidAt = paid.get(c.tenantId!);
      const gone = !t || t.deletedAt !== null || t.status === 'cancelled';
      const left = gone || t.status === 'suspended';

      if (paidAt && left) {
        // Era cliente y se ha dado de baja (o se le suspendió por impago).
        if (c.status === 'lost') continue;
        const { count } = await this.admin.platformLead.updateMany({
          where: { id: c.id, status: c.status },
          data: {
            status: 'lost',
            lostAt: now,
            lostReasonCode: 'churned',
            lostReason: null,
            awaitingReplySince: null,
            ...ARCHIVE_CLEAR,
          },
        });
        if (count !== 1) continue;
        churned += 1;
        await this.closePendingFollowups(c.id, now);
        await this.stopSequence(c.id, 'stage');
        await this.addActivity(
          c.id,
          'system',
          `Perdido: ${PLATFORM_LEAD_LOST_REASON_LABELS.churned}`,
          null,
        );
        // Dado de baja (no una suspensión por impago): lo intenta recuperar el
        // mismo comercial que lo trajo, desde sus archivados.
        if (gone && c.salesRepId) await this.archiveChurned(c, now);
        continue;
      }

      if (paidAt) {
        if (c.status === 'customer') continue;
        const back = c.status === 'lost' && c.lostReasonCode === 'churned';
        const { count } = await this.admin.platformLead.updateMany({
          where: { id: c.id, status: c.status },
          data: {
            status: 'customer',
            ...(back ? {} : { customerAt: paidAt }),
            lostAt: null,
            lostReasonCode: null,
            lostReason: null,
            ...ARCHIVE_CLEAR,
          },
        });
        if (count === 1) {
          customers += 1;
          await this.markRecoveryWon(c.id, c.tenantId!, now);
          await this.addActivity(
            c.id,
            'system',
            back ? 'Vuelve a pagar: otra vez cliente' : 'Primer pago: ya es cliente',
            null,
          );
          // El «volver a contactar» de la prueba sin contratar ya no toca.
          await this.admin.platformLeadFollowup.updateMany({
            where: {
              leadId: c.id,
              status: 'pending',
              superAdminId: null,
              title: { startsWith: 'Volver a contactar' },
            },
            data: { status: 'done', completedAt: now },
          });
        }
        continue;
      }

      if (c.status !== 'trial' || !t || t.billingExempt) continue;
      const sub = t.subscription;
      // Sigue pudiendo pagar: suscripción activa o atrasada de un plan de pago.
      const paying =
        !!sub &&
        (sub.status === 'active' || sub.status === 'past_due') &&
        Number(sub.plan.priceMonthly) > 0;
      const trialOver =
        gone ||
        (!!t.trialEndedAt &&
          t.trialEndedAt.getTime() < graceLimit &&
          !paying &&
          !inFlight.has(c.tenantId!));
      if (!trialOver) continue;
      const { count } = await this.admin.platformLead.updateMany({
        where: { id: c.id, status: 'trial' },
        data: {
          status: 'lost',
          lostAt: now,
          lostReasonCode: 'no_conversion',
          lostReason: null,
          awaitingReplySince: null,
          ...ARCHIVE_CLEAR,
        },
      });
      if (count !== 1) continue;
      lost += 1;
      await this.closePendingFollowups(c.id, now);
      await this.stopSequence(c.id, 'stage');
      await this.addActivity(
        c.id,
        'system',
        `Perdido: ${PLATFORM_LEAD_LOST_REASON_LABELS.no_conversion}`,
        null,
      );
      await this.admin.platformLeadFollowup.create({
        data: {
          leadId: c.id,
          assignedToId: c.assignedToId,
          title: 'Volver a contactar: acabó la prueba sin contratar',
          dueDate: new Date(
            `${isoDate(new Date(now.getTime() + PLATFORM_LEAD_TRIAL_RECONTACT_DAYS * DAY))}T00:00:00Z`,
          ),
        },
      });
    }
    return { customers, lost, churned };
  }

  /** Cliente de un comercial que se da de baja: a sus archivados, con su recordatorio. */
  private async archiveChurned(
    c: {
      id: string;
      tenantId: string | null;
      salesRepId: string | null;
      tenant: { name: string } | null;
    },
    now: Date,
  ): Promise<void> {
    try {
      const recoverOn = await this.proposedRecoverOn('churned', now);
      await this.archiveForRep(c.id, {
        repId: c.salesRepId!,
        tenantId: c.tenantId,
        kind: 'client',
        reasonCode: 'churned',
        recoverOn,
        doNotContact: false,
        byId: null,
        now,
      });
      await this.admin.superAdminNotification.create({
        data: {
          type: 'sales.client_churned',
          title: `${c.tenant?.name ?? 'Un cliente tuyo'} se ha dado de baja`,
          body: `Lo tienes en tus archivados de «Prospectos» para volver a intentarlo el ${dayLabel(recoverOn)}. Si vuelve a contratar, cobras la mitad de la comisión.`,
          link: `/admin/sales/accounts/${c.id}`,
          recipientId: c.salesRepId!,
        },
      });
    } catch (err) {
      this.logger.warn(`[leads] archivar la baja ${c.id}: ${String(err)}`);
    }
  }

  /**
   * Leads nuevos que llevan horas esperando respuesta (de la última semana):
   * un aviso por espera (panel, móvil y, si está activado, chat). La espera
   * cuenta desde su último mensaje sin responder (un perdido que vuelve a
   * escribir empieza de nuevo).
   */
  async unattended(now = new Date()): Promise<{ id: string; name: string; hours: number }[]> {
    const window = {
      lt: new Date(now.getTime() - PLATFORM_LEAD_UNATTENDED_HOURS * HOUR),
      gte: new Date(now.getTime() - 7 * DAY),
    };
    const rows = await this.admin.platformLead.findMany({
      where: {
        discardedAt: null,
        status: 'new',
        unattendedNotifiedAt: null,
        OR: [
          { awaitingReplySince: window },
          // Los que se dan de alta sin marcar la espera (importaciones…).
          { awaitingReplySince: null, firstResponseAt: null, createdAt: window },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const claimed: { id: string; name: string; hours: number }[] = [];
    for (const r of rows) {
      const { count } = await this.admin.platformLead.updateMany({
        where: { id: r.id, unattendedNotifiedAt: null },
        data: { unattendedNotifiedAt: now },
      });
      if (count !== 1) continue;
      const since = r.awaitingReplySince ?? r.createdAt;
      const hours = Math.floor((now.getTime() - since.getTime()) / HOUR);
      const name = platformLeadName(r);
      claimed.push({ id: r.id, name, hours });
      await this.platform.notify({
        type: 'platform_lead.unattended',
        title: `${name} lleva ${hours} h sin atender`,
        ...(r.message ? { body: r.message.slice(0, 200) } : {}),
        link: `/admin/leads?lead=${r.id}`,
      });
    }
    return claimed;
  }

  // ----------------------------------------------------------- duplicados

  /**
   * Posibles duplicados de un lead: otros leads con el mismo email o teléfono
   * o una empresa parecida, y cuentas que ya existen (email de un usuario,
   * nombre parecido o el mismo NIF). Aviso, no bloqueo (salvo el mismo email o
   * teléfono al dar de alta, que ya da 409).
   */
  async possibleDuplicates(l: {
    id?: string | null;
    email: string | null;
    phone: string | null;
    companyName: string | null;
    contactName?: string | null;
    message?: string | null;
    tenantId?: string | null;
  }): Promise<PlatformLeadDuplicateDto[]> {
    const out: PlatformLeadDuplicateDto[] = [];
    const seen = new Set<string>();
    const push = (d: PlatformLeadDuplicateDto) => {
      const key = `${d.kind}:${d.id}`;
      if (seen.has(key) || (d.kind === 'lead' && d.id === l.id)) return;
      if (d.kind === 'tenant' && d.id === l.tenantId) return;
      seen.add(key);
      out.push(d);
    };
    const exceptId = l.id ? { id: { not: l.id } } : {};
    const email = clean(l.email)?.toLowerCase() ?? null;
    if (email) {
      const rows = await this.admin.platformLead.findMany({
        where: { discardedAt: null, email: { equals: email, mode: 'insensitive' }, ...exceptId },
        select: { id: true, companyName: true, contactName: true, email: true, status: true },
        take: 5,
      });
      for (const r of rows) {
        push({
          kind: 'lead',
          id: r.id,
          name: platformLeadName(r),
          reason: 'Mismo email',
          exact: true,
          status: r.status as PlatformLeadStage,
          slug: null,
        });
      }
      const users = await this.admin.user.findMany({
        where: { email: { equals: email, mode: 'insensitive' }, tenant: { deletedAt: null } },
        select: { tenant: { select: { id: true, name: true, slug: true } } },
        take: 5,
      });
      for (const u of users) {
        push({
          kind: 'tenant',
          id: u.tenant.id,
          name: u.tenant.name,
          reason: 'Su email es de un usuario de esta cuenta',
          exact: true,
          status: null,
          slug: u.tenant.slug,
        });
      }
    }
    const tail = digits(l.phone).slice(-9);
    if (tail.length === 9) {
      const rows = await this.admin.$queryRaw<
        { id: string; company_name: string | null; contact_name: string | null; status: string }[]
      >`
        SELECT id, company_name, contact_name, status FROM platform_leads
        WHERE discarded_at IS NULL AND phone IS NOT NULL
          AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ${tail}
          ${l.id ? Prisma.sql`AND id <> ${l.id}::uuid` : Prisma.empty}
        LIMIT 5`;
      for (const r of rows) {
        push({
          kind: 'lead',
          id: r.id,
          name: platformLeadName({ companyName: r.company_name, contactName: r.contact_name }),
          reason: 'Mismo teléfono',
          exact: true,
          status: r.status as PlatformLeadStage,
          slug: null,
        });
      }
    }
    const company = clean(l.companyName);
    const word = company
      ?.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^A-Za-z0-9]+/)
      .filter((w) => w.length >= 4 && !/^(trasteros?|storage|almacen(es)?|sociedad)$/i.test(w))
      .sort((a, b) => b.length - a.length)[0];
    if (company && word) {
      const contains = { contains: word, mode: 'insensitive' as const };
      const [leads, tenants] = await Promise.all([
        this.admin.platformLead.findMany({
          where: { discardedAt: null, companyName: contains, ...exceptId },
          select: { id: true, companyName: true, contactName: true, email: true, status: true },
          take: 40,
        }),
        this.admin.tenant.findMany({
          where: { deletedAt: null, OR: [{ name: contains }, { billingLegalName: contains }] },
          select: { id: true, name: true, slug: true, billingLegalName: true },
          take: 40,
        }),
      ]);
      for (const r of leads) {
        if (!similarCompanyNames(company, r.companyName)) continue;
        push({
          kind: 'lead',
          id: r.id,
          name: platformLeadName(r),
          reason: 'Empresa parecida',
          exact: false,
          status: r.status as PlatformLeadStage,
          slug: null,
        });
      }
      for (const t of tenants) {
        if (
          !similarCompanyNames(company, t.name) &&
          !similarCompanyNames(company, t.billingLegalName)
        )
          continue;
        push({
          kind: 'tenant',
          id: t.id,
          name: t.name,
          reason: 'Cuenta con un nombre parecido',
          exact: false,
          status: null,
          slug: t.slug,
        });
      }
    }
    const taxId = findTaxId(`${company ?? ''} ${l.message ?? ''}`);
    if (taxId) {
      const tenants = await this.admin.tenant.findMany({
        where: { deletedAt: null, taxId: { equals: taxId, mode: 'insensitive' } },
        select: { id: true, name: true, slug: true },
        take: 3,
      });
      for (const t of tenants) {
        push({
          kind: 'tenant',
          id: t.id,
          name: t.name,
          reason: `Mismo NIF (${taxId})`,
          exact: true,
          status: null,
          slug: t.slug,
        });
      }
    }
    return out.slice(0, 10);
  }

  // ------------------------------------------------------------ secuencia

  /** Activa o para los correos automáticos de un lead desde su ficha. */
  async setSequence(
    id: string,
    input: { enabled: boolean; sequenceId?: string | undefined },
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    const lead = await this.leadOrThrow(id);
    if (input.enabled) {
      this.assertContactable(lead);
      await this.sequences.start(id, {
        sequenceId: input.sequenceId ?? null,
        byId: actor.superAdminId,
        auto: false,
      });
      await this.addActivity(id, 'system', 'Secuencia de correos activada', actor.superAdminId);
    } else {
      await this.admin.platformLead.update({ where: { id }, data: { sequenceOptOut: true } });
      const stopped = await this.sequences.stop(id, 'manual');
      await this.addActivity(
        id,
        'system',
        stopped ? 'Secuencia de correos parada' : 'Sin correos automáticos para este lead',
        actor.superAdminId,
      );
    }
    await this.record(actor, input.enabled ? 'sequence_started' : 'sequence_stopped', id);
    return this.detail(id);
  }

  // ------------------------------------------------------ correo entrante

  /** Guarda los adjuntos válidos de un correo entrante en la carpeta del lead. */
  private async storeInboundAttachments(
    leadId: string,
    list: EmailInboundInput['attachments'],
  ): Promise<StoredAttachment[]> {
    const stored: StoredAttachment[] = [];
    for (const att of (list ?? []).slice(0, PLATFORM_LEAD_MAX_ATTACHMENTS)) {
      const mimeType = MESSAGE_ATTACHMENT_MIME_TYPES.find(
        (m) => m === att.contentType.split(';')[0]?.trim().toLowerCase(),
      );
      if (!mimeType) continue;
      const body = Buffer.from(att.contentBase64, 'base64');
      if (body.length === 0 || body.length > MESSAGE_ATTACHMENT_MAX_BYTES) continue;
      const key = `${this.attachmentPrefix(leadId)}${randomUUID()}.${mimeType.split('/')[1]}`;
      await this.files.putObject({ bucket: 'uploads', key, body, contentType: mimeType });
      stored.push({ key, mimeType, filename: (att.filename || 'adjunto').slice(0, 200) });
    }
    return stored;
  }

  /**
   * El lead contesta a un correo nuestro (su dirección `p-…` dice de quién es):
   * queda en su conversación, espera respuesta, se paran los correos
   * automáticos y se avisa a quien lo lleva. Un perdido sin cuenta vuelve a
   * «Nuevo». Devuelve false si la dirección no es de ningún lead.
   */
  async recordEmailReply(token: string, input: EmailInboundInput): Promise<boolean> {
    const lead = await this.admin.platformLead.findUnique({ where: { replyToken: token } });
    if (!lead) return false;
    const target = lead.mergedIntoId
      ? ((await this.admin.platformLead.findUnique({ where: { id: lead.mergedIntoId } })) ?? lead)
      : lead;
    const text = stripQuotedReply(input.text).slice(0, 5000).trim();
    const attachments = await this.storeInboundAttachments(target.id, input.attachments);
    if (!text && attachments.length === 0) return false;
    const sameSender = target.email?.toLowerCase() === input.from.trim().toLowerCase();
    const body = text || attachments.map((a) => attachmentLabel(a.filename)).join(' ');
    const now = new Date();
    await this.addActivity(
      target.id,
      'email_in',
      sameSender ? body : `[De ${input.from}] ${body}`,
      null,
      { subject: input.subject ? input.subject.slice(0, 200) : null, attachments, occurredAt: now },
    );
    if (target.discardedAt) return true;
    await this.admin.platformLead.update({
      where: { id: target.id },
      data: {
        awaitingReplySince: target.awaitingReplySince ?? now,
        ...(target.status === 'lost' && !target.tenantId
          ? {
              status: 'new',
              lostAt: null,
              lostReasonCode: null,
              lostReason: null,
              unattendedNotifiedAt: null,
            }
          : {}),
      },
    });
    await this.platform.notify({
      type: 'platform_lead.email_reply',
      title: `${platformLeadName(target)} ha respondido`,
      body: body.slice(0, 200),
      link: `/admin/leads?lead=${target.id}`,
      recipientId: target.assignedToId,
    });
    return true;
  }

  // ------------------------------------------------------------- reparto

  async leadIdForTenant(tenantId: string): Promise<string | null> {
    const lead = await this.admin.platformLead.findUnique({
      where: { tenantId },
      select: { id: true },
    });
    return lead?.id ?? null;
  }

  /**
   * Reparte un lead que ha entrado solo y no tiene responsable (por turnos o
   * por zona), con el plazo para la primera respuesta. Respeta la cartera de
   * los comerciales: si ya es de uno, no se toca.
   */
  async autoAssign(leadId: string, now = new Date()): Promise<string | null> {
    const lead = await this.admin.platformLead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        assignedToId: true,
        salesRepId: true,
        discardedAt: true,
        status: true,
        firstResponseAt: true,
        city: true,
        companyName: true,
        contactName: true,
        email: true,
      },
    });
    if (!lead || lead.assignedToId || lead.salesRepId || lead.discardedAt) return null;
    if (lead.status === 'customer' || lead.status === 'lost') return null;
    const assignee = await this.settings.pickAssignee(lead);
    if (!assignee) return null;
    const waiting = lead.status === 'new' && !lead.firstResponseAt;
    const { count } = await this.admin.platformLead.updateMany({
      where: { id: leadId, assignedToId: null },
      data: {
        assignedToId: assignee,
        autoAssignedAt: now,
        responseDueAt: waiting ? await this.settings.deadline(now) : null,
      },
    });
    if (count !== 1) return null;
    await this.applyPortfolio(leadId, assignee, null);
    const who = await this.admin.superAdmin.findUnique({
      where: { id: assignee },
      select: { fullName: true },
    });
    await this.addActivity(
      leadId,
      'system',
      `Asignado automáticamente a ${who?.fullName ?? 'alguien del equipo'}`,
      null,
    );
    await this.platform.notify({
      type: 'platform_lead.assigned',
      title: `Te ha tocado un lead: ${platformLeadName(lead)}`,
      ...(waiting ? { body: 'Responde cuanto antes: tiene un plazo de primera respuesta.' } : {}),
      link: `/admin/leads?lead=${leadId}`,
      recipientId: assignee,
    });
    return assignee;
  }

  /**
   * Leads repartidos solos que siguen sin primera respuesta pasado el plazo:
   * pasan al siguiente del turno (una sola vez), con aviso a los dos.
   */
  async reassignOverdue(now = new Date()): Promise<number> {
    const s = await this.settings.get();
    if (!s.reassignEnabled || s.assignMode === 'off') return 0;
    const rows = await this.admin.platformLead.findMany({
      where: {
        discardedAt: null,
        status: 'new',
        firstResponseAt: null,
        reassignedAt: null,
        responseDueAt: { lt: now },
        assignedToId: { not: null },
      },
      take: 50,
    });
    let moved = 0;
    for (const r of rows) {
      const next = await this.settings.nextInTurn(r.assignedToId);
      if (!next) continue;
      const { count } = await this.admin.platformLead.updateMany({
        where: {
          id: r.id,
          reassignedAt: null,
          assignedToId: r.assignedToId,
          firstResponseAt: null,
        },
        data: {
          assignedToId: next,
          reassignedAt: now,
          autoAssignedAt: now,
          responseDueAt: await this.settings.deadline(now),
        },
      });
      if (count !== 1) continue;
      moved += 1;
      await this.applyPortfolio(r.id, next, null);
      const names = await this.admin.superAdmin.findMany({
        where: { id: { in: [r.assignedToId!, next] } },
        select: { id: true, fullName: true },
      });
      const nameOf = (id: string) => names.find((n) => n.id === id)?.fullName ?? 'alguien';
      const name = platformLeadName(r);
      await this.addActivity(
        r.id,
        'system',
        `Sin respuesta en plazo: pasa de ${nameOf(r.assignedToId!)} a ${nameOf(next)}`,
        null,
      );
      await this.platform.notify({
        type: 'platform_lead.reassigned',
        title: `${name} pasa a ${nameOf(next)}`,
        body: 'Se pasó el plazo de primera respuesta.',
        link: `/admin/leads?lead=${r.id}`,
        recipientId: r.assignedToId,
      });
      await this.platform.notify({
        type: 'platform_lead.assigned',
        title: `Te ha tocado un lead: ${name}`,
        body: `Era de ${nameOf(r.assignedToId!)} y nadie le había respondido a tiempo.`,
        link: `/admin/leads?lead=${r.id}`,
        recipientId: next,
      });
    }
    return moved;
  }

  // ---------------------------------------------------------------- parados

  /** Leads abiertos parados (pasado el umbral de su fase), los de alto valor primero. */
  async staleLeads(now = new Date()): Promise<PlatformLeadDto[]> {
    const rows = await this.admin.platformLead.findMany({
      where: { discardedAt: null, status: { in: ['new', 'contacted', 'interested', 'trial'] } },
      include: LEAD_INCLUDE,
      take: 2000,
    });
    const items = await this.toDtos(rows, undefined, now);
    return items
      .filter((l) => l.staleDays !== null)
      .sort(
        (a, b) =>
          Number(b.highValue) - Number(a.highValue) ||
          (b.staleDays ?? 0) - (a.staleDays ?? 0) ||
          a.id.localeCompare(b.id),
      );
  }

  /** Aviso a quien lo lleva: una vez por lead y fase. */
  async notifyStale(now = new Date()): Promise<number> {
    const stale = await this.staleLeads(now);
    let sent = 0;
    for (const l of stale) {
      const { count } = await this.admin.platformLead.updateMany({
        where: {
          id: l.id,
          status: l.status,
          OR: [{ staleNotifiedStatus: null }, { staleNotifiedStatus: { not: l.status } }],
        },
        data: { staleNotifiedStatus: l.status, staleNotifiedAt: now },
      });
      if (count !== 1) continue;
      sent += 1;
      await this.platform.notify({
        type: 'platform_lead.stale',
        title: `${l.displayName} lleva ${l.staleDays} días parado`,
        body: `${PLATFORM_LEAD_STAGE_LABELS[l.status]}${l.estimatedMonthly ? ` · ${l.estimatedMonthly.toFixed(2).replace('.', ',')} € al mes previstos` : ''}`,
        link: `/admin/leads?lead=${l.id}`,
        recipientId: l.assignedToId,
      });
    }
    return sent;
  }

  // -------------------------------------------------------------- cifras

  /**
   * Resultados de los leads que entraron desde el día 1 del mes de hace N-1
   * meses (hora de España). El embudo cuenta las fases por las que pasó cada
   * uno de verdad (con su fecha); quien entró directamente en prueba (se
   * registró solo o se le creó la cuenta) va aparte.
   */
  async stats(
    months: number,
    opts: { source?: PlatformLeadSource | null } = {},
    now = new Date(),
  ): Promise<PlatformLeadStatsDto> {
    const m = Math.min(Math.max(Math.round(months) || 6, 1), 24);
    const index = madridMonthIndex(now);
    const from = monthIndexStart(index - (m - 1));
    const prevFrom = monthIndexStart(index - (2 * m - 1));
    const source = opts.source ?? null;
    const select = {
      status: true,
      source: true,
      tenantId: true,
      createdById: true,
      assignedToId: true,
      utmCampaign: true,
      contactedAt: true,
      interestedAt: true,
      trialAt: true,
      customerAt: true,
      lostReasonCode: true,
      firstResponseAt: true,
      createdAt: true,
    } satisfies Prisma.PlatformLeadSelect;
    const bySource = source ? { source } : {};
    const [leads, previous, discarded, openRows, ctx] = await Promise.all([
      this.admin.platformLead.findMany({
        where: { discardedAt: null, createdAt: { gte: from }, ...bySource },
        select,
      }),
      this.admin.platformLead.findMany({
        where: { discardedAt: null, createdAt: { gte: prevFrom, lt: from }, ...bySource },
        select,
      }),
      this.admin.platformLead.groupBy({
        by: ['discardReasonCode'],
        where: { discardedAt: { not: null }, createdAt: { gte: from }, ...bySource },
        _count: { _all: true },
      }),
      this.admin.platformLead.findMany({
        where: {
          discardedAt: null,
          status: { in: ['new', 'contacted', 'interested', 'trial'] },
          ...bySource,
        },
        select: { status: true, units: true, planSlug: true },
      }),
      this.insightContext(),
    ]);
    // MRR sin IVA, con atrasados, anual/12 y descuento: el mismo de Métricas.
    const mrrByTenant = await currentMrrByTenant(this.admin);
    const mrrOf = (tenantId: string | null) =>
      tenantId ? (mrrByTenant.get(tenantId)?.total ?? 0) : 0;
    // Entró ya en prueba: su cuenta y su lead nacen a la vez (o la cuenta, antes).
    type Row = (typeof leads)[number];
    const isDirect = (l: Row) =>
      !!l.trialAt && l.trialAt.getTime() <= l.createdAt.getTime() + 60_000;
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const medianOf = (xs: number[]) => {
      if (xs.length === 0) return null;
      const v = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(v.length / 2);
      return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
    };
    const responseHoursOf = (rows: Row[]) =>
      rows
        .filter((l) => l.firstResponseAt && !l.createdById && INBOUND_SOURCES.has(l.source))
        .map((l) => Math.max(0, (l.firstResponseAt!.getTime() - l.createdAt.getTime()) / HOUR));
    const customersOf = (rows: Row[]) => rows.filter((l) => !!l.customerAt).length;
    const mrrSum = (rows: Row[]) =>
      round2(
        rows.filter((l) => l.status === 'customer').reduce((a, l) => a + mrrOf(l.tenantId), 0),
      );
    const pctOf = (part: number, whole: number) => (whole ? round1((part / whole) * 100) : null);

    const bySourceMap = new Map<
      string,
      { leads: number; trials: number; customers: number; mrr: number }
    >();
    const reasons = new Map<string, number>();
    const daysToCustomer: number[] = [];
    const funnel = [0, 0, 0, 0, 0];
    const direct = { leads: 0, customers: 0 };
    const stageSpans: Record<'new' | 'contacted' | 'interested' | 'trial', number[]> = {
      new: [],
      contacted: [],
      interested: [],
      trial: [],
    };
    const span = (a: Date | null, b: Date | null) =>
      a && b && b.getTime() >= a.getTime() ? (b.getTime() - a.getTime()) / DAY : null;
    let lostCount = 0;
    let churned = 0;
    for (const l of leads) {
      const isCustomer = l.status === 'customer';
      if (isDirect(l)) {
        direct.leads += 1;
        if (l.customerAt) direct.customers += 1;
      } else {
        funnel[0]! += 1;
        if (l.contactedAt) funnel[1]! += 1;
        if (l.interestedAt) funnel[2]! += 1;
        if (l.trialAt) funnel[3]! += 1;
        if (l.customerAt) funnel[4]! += 1;
        // Días en cada fase: hasta la siguiente por la que pasó de verdad.
        const steps: [keyof typeof stageSpans, Date | null, Date | null][] = [
          ['new', l.createdAt, l.contactedAt ?? l.interestedAt ?? l.trialAt],
          ['contacted', l.contactedAt, l.interestedAt ?? l.trialAt],
          ['interested', l.interestedAt, l.trialAt],
          ['trial', l.trialAt, l.customerAt],
        ];
        for (const [stage, a, b] of steps) {
          const d = span(a, b);
          if (d !== null) stageSpans[stage].push(d);
        }
      }
      const sRow = bySourceMap.get(l.source) ?? { leads: 0, trials: 0, customers: 0, mrr: 0 };
      sRow.leads += 1;
      if (l.trialAt) sRow.trials += 1;
      if (l.customerAt) sRow.customers += 1;
      if (isCustomer) sRow.mrr += mrrOf(l.tenantId);
      bySourceMap.set(l.source, sRow);
      if (l.status === 'lost') {
        if (l.lostReasonCode === 'churned') {
          churned += 1;
        } else {
          lostCount += 1;
          const code = l.lostReasonCode ?? 'other';
          reasons.set(code, (reasons.get(code) ?? 0) + 1);
        }
      }
      if (l.customerAt) {
        daysToCustomer.push(Math.max(0, (l.customerAt.getTime() - l.createdAt.getTime()) / DAY));
      }
    }
    const median = medianOf(responseHoursOf(leads));
    const prevMedian = medianOf(responseHoursOf(previous));
    const bySourceRows = [...bySourceMap.entries()]
      .map(([src, x]) => ({
        source: src as PlatformLeadSource,
        leads: x.leads,
        trials: x.trials,
        customers: x.customers,
        mrr: round2(x.mrr),
        conversionPct: pctOf(x.customers, x.leads),
      }))
      .sort((a, b) => b.customers - a.customers || b.leads - a.leads);

    const group = (keyOf: (l: Row) => string | null) => {
      const map = new Map<string | null, Row[]>();
      for (const l of leads) {
        const k = keyOf(l);
        map.set(k, [...(map.get(k) ?? []), l]);
      }
      return map;
    };
    const assigneeIds = [
      ...new Set(leads.map((l) => l.assignedToId).filter((x): x is string => !!x)),
    ];
    const admins = assigneeIds.length
      ? await this.admin.superAdmin.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const nameOf = new Map(admins.map((a) => [a.id, a.fullName]));
    const groupDto = (map: Map<string | null, Row[]>, label: (k: string | null) => string) =>
      [...map.entries()]
        .map(([key, rows]) => ({
          key,
          label: label(key),
          leads: rows.length,
          customers: customersOf(rows),
          conversionPct: pctOf(customersOf(rows), rows.length),
          mrr: mrrSum(rows),
        }))
        .sort((a, b) => b.customers - a.customers || b.leads - a.leads);

    const valueStages = EMPTY_STAGE_COUNTS();
    const valueLeads = EMPTY_STAGE_COUNTS();
    for (const r of openRows) {
      const v = estimatePlatformLeadValue(r, ctx.value);
      valueStages[r.status as PlatformLeadStage] += v?.monthly ?? 0;
      valueLeads[r.status as PlatformLeadStage] += 1;
    }

    const prevCustomers = customersOf(previous);
    return {
      months: m,
      from: from.toISOString(),
      source,
      leads: leads.length,
      funnel: (['new', 'contacted', 'interested', 'trial', 'customer'] as const).map(
        (stage, i) => ({ stage, reached: funnel[i]! }),
      ),
      direct,
      lost: lostCount,
      churned,
      bySource: bySourceRows,
      lostReasons: [...reasons.entries()]
        .map(([code, count]) => ({ code: code as PlatformLeadLostReason, count }))
        .sort((a, b) => b.count - a.count),
      medianFirstResponseHours: median === null ? null : round1(median),
      avgDaysToCustomer: daysToCustomer.length
        ? round1(daysToCustomer.reduce((a, b) => a + b, 0) / daysToCustomer.length)
        : null,
      mrr: round2(bySourceRows.reduce((a, x) => a + x.mrr, 0)),
      stageDays: (['new', 'contacted', 'interested', 'trial'] as const).map((stage) => ({
        stage,
        avgDays: stageSpans[stage].length
          ? round1(stageSpans[stage].reduce((a, b) => a + b, 0) / stageSpans[stage].length)
          : null,
        count: stageSpans[stage].length,
      })),
      byAssignee: groupDto(
        group((l) => l.assignedToId),
        (k) => (k ? (nameOf.get(k) ?? 'Alguien que ya no está') : 'Sin responsable'),
      ),
      byCampaign: groupDto(
        group((l) => clean(l.utmCampaign)),
        (k) => k ?? 'Sin campaña',
      ),
      discardReasons: discarded
        .map((d) => ({
          code: (d.discardReasonCode ?? 'other') as PlatformLeadDiscardReason,
          count: d._count._all,
        }))
        .reduce<{ code: PlatformLeadDiscardReason; count: number }[]>((acc, d) => {
          const found = acc.find((x) => x.code === d.code);
          if (found) found.count += d.count;
          else acc.push({ ...d });
          return acc;
        }, [])
        .sort((a, b) => b.count - a.count),
      previous: {
        from: prevFrom.toISOString(),
        leads: previous.length,
        customers: prevCustomers,
        conversionPct: pctOf(prevCustomers, previous.length),
        mrr: mrrSum(previous),
        medianFirstResponseHours: prevMedian === null ? null : round1(prevMedian),
      },
      valueByStage: (['new', 'contacted', 'interested', 'trial'] as const).map((stage) => ({
        stage,
        leads: valueLeads[stage],
        value: round2(valueStages[stage]),
      })),
    };
  }

  /** CSV de los leads del filtro (o solo de los elegidos, `ids`). */
  async exportCsv(q: PlatformLeadsQuery, superAdminId: string, ids?: string[]): Promise<string> {
    const rows = await this.admin.platformLead.findMany({
      where: ids?.length ? { id: { in: ids } } : this.listWhere(q, superAdminId),
      include: LEAD_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const items = await this.toDtos(rows);
    // Sin fórmulas: los datos los escribe quien rellena el formulario de la web.
    const cell = csvLineCell;
    const date = (d: string | null) =>
      d ? new Date(d).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }) : '';
    const header = [
      'Alta',
      'Empresa',
      'Persona',
      'Email',
      'Teléfono',
      'Trasteros',
      'Locales',
      'Perfil',
      'Programa actual',
      'Ciudad',
      'Origen',
      'Campaña',
      'Fase',
      'Responsable',
      'Cuenta',
      'Motivo de pérdida',
      'Plan',
      'Primera respuesta',
      'Cliente desde',
      'Puntuación',
      'Cuota prevista al mes (sin IVA)',
      'Motivo de descarte',
    ];
    const lines = items.map((l) =>
      [
        date(l.createdAt),
        l.companyName,
        l.contactName,
        l.email,
        l.phone,
        l.units,
        l.facilities,
        l.profile,
        l.currentSoftware,
        l.city,
        PLATFORM_LEAD_SOURCE_LABELS[l.source] ?? l.source,
        [l.utmSource, l.utmCampaign].filter(Boolean).join(' / '),
        PLATFORM_LEAD_STAGE_LABELS[l.status],
        l.assignedToName,
        l.tenant ? `${l.tenant.name} (${l.tenant.slug})` : '',
        l.lostReasonCode
          ? `${PLATFORM_LEAD_LOST_REASON_LABELS[l.lostReasonCode]}${l.lostReason ? ` — ${l.lostReason}` : ''}`
          : '',
        l.planName ?? l.planSlug,
        date(l.firstResponseAt),
        date(l.customerAt),
        String(l.score),
        l.estimatedMonthly === null ? '' : l.estimatedMonthly.toFixed(2).replace('.', ','),
        l.discardReasonCode
          ? `${PLATFORM_LEAD_DISCARD_REASON_LABELS[l.discardReasonCode]}${l.discardReason ? ` — ${l.discardReason}` : ''}`
          : '',
      ]
        .map(cell)
        .join(';'),
    );
    return `${CSV_BOM}${[header.join(';'), ...lines].join('\r\n')}`;
  }
}

function quoteSummary(q: {
  lines: { label: string }[];
  total: number;
  cycle: 'monthly' | 'yearly';
}): string {
  return `Propuesta: ${q.lines.map((l) => l.label).join(' + ')} → ${q.total
    .toFixed(2)
    .replace('.', ',')} € ${q.cycle === 'yearly' ? 'al año' : 'al mes'}`;
}
