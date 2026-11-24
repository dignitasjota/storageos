import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  PLATFORM_LEAD_ACTIVITY_LABELS,
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_STAGES,
  platformLeadName,
  SALES_APPOINTMENT_KIND_LABELS,
  SALES_APPOINTMENT_STATUS_LABELS,
  SALES_PORTFOLIO_EXPORT_MAX,
  SALES_PORTFOLIO_NO_REP,
  SALES_PORTFOLIO_SORT_DEFAULT_DIR,
  SALES_SOURCE_LABELS,
  SALES_TEMPERATURE_LABELS,
  type MovePlatformLeadInput,
  type PlatformLeadStage,
  type SalesAppointmentKind,
  type SalesAppointmentStatus,
  type SalesArchiveLeadInput,
  type SalesDirectionNoteInput,
  type SalesDirectionReassignInput,
  type SalesPortfolioDetailDto,
  type SalesPortfolioListDto,
  type SalesPortfolioRowDto,
  type SalesPortfoliosQuery,
  type SalesPortfolioSort,
  type SalesTimelineEntryDto,
  type UpdateSalesProfileInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PlatformLeadsService } from '../leads/platform-leads.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAccountsService } from './sales-accounts.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesCommissionsService } from './sales-commissions.service';
import { clean, DAY, profileDto } from './sales-common';
import { SalesNotifyService } from './sales-notify.service';
import { SalesPortfolioService } from './sales-portfolio.service';
import { SalesRecoveryService } from './sales-recovery.service';

/** Lo que cuenta como haber hablado con el cliente. */
const CONTACT_TYPES = ['call', 'whatsapp', 'meeting', 'demo', 'email_out'];
const OPEN_STAGES = ['new', 'contacted', 'interested'];
const PAGE_SIZE = 50;
const CURSOR_RE = /^(\d{1,7})_([0-9a-f-]{36})$/i;
/** Prospectos que lista el aviso a la dirección (el resto, «y N más»). */
const ALERT_SHOWN = 15;

const ARCHIVED: Prisma.PlatformLeadWhereInput = {
  status: 'lost',
  salesArchivedAt: { not: null },
};
const ACTIVE: Prisma.PlatformLeadWhereInput = { NOT: ARCHIVED };

const ENDED_LABELS: Record<string, string> = {
  reassigned: 'pasa a otro comercial',
  released: 'liberado por falta de actividad',
  unassigned: 'queda sin comercial',
};

const PROFILE_FIELD_LABELS: Record<keyof UpdateSalesProfileInput, string> = {
  pinnedNote: 'nota fija',
  status: 'estado',
  temperature: 'temperatura',
  decisionMaker: 'quién decide',
  bestTime: 'mejor momento para llamar',
  nextAction: 'siguiente paso',
};

const ROW_SELECT = {
  id: true,
  status: true,
  source: true,
  units: true,
  facilities: true,
  planSlug: true,
  createdAt: true,
  updatedAt: true,
  salesAssignedAt: true,
  salesRepId: true,
  tenantId: true,
  salesRep: { select: { fullName: true } },
  salesProfile: { select: { lastContactAt: true } },
  followups: {
    where: { status: 'pending' },
    orderBy: { dueDate: 'asc' },
    take: 1,
    select: { dueDate: true },
  },
} satisfies Prisma.PlatformLeadSelect;
type Row = Prisma.PlatformLeadGetPayload<{ select: typeof ROW_SELECT }>;

interface RowFacts {
  lastContactAt: Date | null;
  daysUntouched: number;
}

export interface DirectionActor {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Carteras: lo que ve y hace la dirección con las cuentas de todos los
 * comerciales. La tabla con sus filtros, la ficha completa con la cronología
 * y las acciones de la dirección (nota al comercial, reasignar, editar la
 * ficha comercial, mover de fase, archivar y recuperar), que quedan en la
 * cronología como de la dirección, en el registro de acciones y con aviso al
 * comercial. Una nota o un cambio de la dirección no es contacto con el
 * cliente: no mueve el «último contacto» ni lo saca de «sin tocar».
 */
@Injectable()
export class SalesPortfoliosService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly leads: PlatformLeadsService,
    private readonly assignment: SalesAssignmentService,
    private readonly portfolio: SalesPortfolioService,
    private readonly accounts: SalesAccountsService,
    private readonly recovery: SalesRecoveryService,
    private readonly commissions: SalesCommissionsService,
    private readonly notify: SalesNotifyService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ------------------------------------------------------------------ tabla

  /** Comercial, lote, búsqueda y tipo: lo que comparten la tabla y su embudo. */
  private baseWhere(q: SalesPortfoliosQuery): Prisma.PlatformLeadWhereInput {
    const and: Prisma.PlatformLeadWhereInput[] = [{ discardedAt: null }];
    if (q.rep === SALES_PORTFOLIO_NO_REP) and.push({ salesRepId: null });
    else if (q.rep) and.push({ salesRepId: q.rep });
    else and.push({ salesRepId: { not: null } });
    if (q.batch) and.push({ salesBatch: { equals: q.batch, mode: 'insensitive' } });
    if (q.kind === 'prospects') and.push({ tenantId: null });
    else if (q.kind === 'clients') and.push({ tenantId: { not: null } });
    if (q.search) {
      const contains = { contains: q.search, mode: 'insensitive' as const };
      and.push({
        OR: [
          { companyName: contains },
          { contactName: contains },
          { email: contains },
          { phone: contains },
          { city: contains },
          { tenant: { name: contains } },
        ],
      });
    }
    return { AND: and };
  }

  private listWhere(q: SalesPortfoliosQuery): Prisma.PlatformLeadWhereInput {
    const and: Prisma.PlatformLeadWhereInput[] = [this.baseWhere(q)];
    const scope = q.scope ?? 'active';
    if (scope === 'active') and.push(ACTIVE);
    else if (scope === 'archived') and.push(ARCHIVED);
    if (q.status) and.push({ status: q.status });
    if (q.temperature === 'none') {
      and.push({
        OR: [{ salesProfile: { is: null } }, { salesProfile: { is: { temperature: null } } }],
      });
    } else if (q.temperature) {
      and.push({ salesProfile: { is: { temperature: q.temperature } } });
    }
    return { AND: and };
  }

  /** Último contacto de cada uno: su ficha o la última llamada, WhatsApp, reunión, demo o correo. */
  private async lastContacts(rows: Row[]): Promise<Map<string, Date | null>> {
    const out = new Map<string, Date | null>();
    for (const r of rows) out.set(r.id, r.salesProfile?.lastContactAt ?? null);
    for (let i = 0; i < rows.length; i += 5000) {
      const ids = rows.slice(i, i + 5000).map((r) => r.id);
      const groups = await this.admin.platformLeadActivity.groupBy({
        by: ['leadId'],
        where: { leadId: { in: ids }, type: { in: CONTACT_TYPES } },
        _max: { occurredAt: true },
      });
      for (const g of groups) {
        const d = g._max.occurredAt;
        const prev = out.get(g.leadId) ?? null;
        if (d && (!prev || d > prev)) out.set(g.leadId, d);
      }
    }
    return out;
  }

  private facts(row: Row, last: Date | null, now: Date): RowFacts {
    const since = last ?? row.salesAssignedAt ?? row.createdAt;
    return {
      lastContactAt: last,
      daysUntouched: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY)),
    };
  }

  /** Todos los que cumplen los filtros, ya ordenados. */
  private async ordered(
    q: SalesPortfoliosQuery,
    now: Date,
  ): Promise<{ rows: Row[]; facts: Map<string, RowFacts> }> {
    const rows = await this.admin.platformLead.findMany({
      where: this.listWhere(q),
      select: ROW_SELECT,
    });
    const last = await this.lastContacts(rows);
    const facts = new Map(rows.map((r) => [r.id, this.facts(r, last.get(r.id) ?? null, now)]));
    let matching = rows;
    if (q.neverContacted) matching = matching.filter((r) => !facts.get(r.id)?.lastContactAt);
    if (q.untouchedDays) {
      const min = q.untouchedDays;
      matching = matching.filter((r) => (facts.get(r.id)?.daysUntouched ?? 0) >= min);
    }
    const sorted = await this.sortRows(matching, facts, q.sort ?? 'untouched', q.dir, now);
    return { rows: sorted, facts };
  }

  private async sortRows(
    rows: Row[],
    facts: Map<string, RowFacts>,
    sort: SalesPortfolioSort,
    dir: 'asc' | 'desc' | undefined,
    now: Date,
  ): Promise<Row[]> {
    const sign = (dir ?? SALES_PORTFOLIO_SORT_DEFAULT_DIR[sort]) === 'asc' ? 1 : -1;
    const ranks =
      sort === 'priority' || sort === 'value' ? await this.leads.rankRows(rows, now) : null;
    const stageIndex = (s: string) => PLATFORM_LEAD_STAGES.indexOf(s as PlatformLeadStage);
    const key = (r: Row): number | string | null => {
      switch (sort) {
        case 'untouched':
          return facts.get(r.id)?.daysUntouched ?? 0;
        case 'priority':
          return ranks?.get(r.id)?.score ?? 0;
        case 'value':
          return ranks?.get(r.id)?.monthly ?? null;
        case 'next_step':
          return r.followups[0]?.dueDate.getTime() ?? null;
        case 'rep':
          return r.salesRep?.fullName.toLocaleLowerCase('es') ?? null;
        case 'stage':
          return stageIndex(r.status);
        case 'assigned':
          return r.salesAssignedAt?.getTime() ?? null;
        default:
          return r.updatedAt.getTime();
      }
    };
    const keys = new Map(rows.map((r) => [r.id, key(r)]));
    return [...rows].sort((a, b) => {
      const ka = keys.get(a.id) ?? null;
      const kb = keys.get(b.id) ?? null;
      // Los que no tienen el dato, al final en los dos sentidos.
      if (ka === null || kb === null) {
        if (ka !== kb) return ka === null ? 1 : -1;
      } else if (ka !== kb) {
        const cmp =
          typeof ka === 'string' && typeof kb === 'string'
            ? ka.localeCompare(kb, 'es')
            : (ka as number) - (kb as number);
        if (cmp !== 0) return cmp * sign;
      }
      // Desempate: lo que lleva más días sin tocar y, después, el más reciente.
      const da = facts.get(a.id)?.daysUntouched ?? 0;
      const db = facts.get(b.id)?.daysUntouched ?? 0;
      if (da !== db) return db - da;
      return b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1);
    });
  }

  /** Las filas de la tabla con sus datos de dirección, en el orden de `ids`. */
  private async rows(ids: string[], facts: Map<string, RowFacts>): Promise<SalesPortfolioRowDto[]> {
    if (ids.length === 0) return [];
    const [dtos, extra, assignments] = await Promise.all([
      this.portfolio.dtosInOrder(ids),
      this.admin.platformLead.findMany({
        where: { id: { in: ids } },
        select: { id: true, salesRepId: true, salesRep: { select: { isActive: true } } },
      }),
      this.admin.salesAssignment.findMany({
        where: { leadId: { in: ids }, endedAt: null },
        select: { leadId: true, source: true },
      }),
    ]);
    const extraOf = new Map(extra.map((e) => [e.id, e]));
    const sourceOf = new Map(assignments.map((a) => [a.leadId, a.source]));
    const tenantIds = dtos.map((d) => d.tenant?.id).filter((x): x is string => !!x);
    const monthly = tenantIds.length
      ? await this.commissions.monthlyByTenant(tenantIds)
      : new Map<string, number>();
    return dtos.map((d) => {
      const e = extraOf.get(d.id);
      const f = facts.get(d.id);
      return {
        ...d,
        salesRepId: e?.salesRepId ?? null,
        salesRepActive: e?.salesRep ? e.salesRep.isActive : null,
        lastContactAt: f?.lastContactAt?.toISOString() ?? null,
        neverContacted: !f?.lastContactAt,
        daysUntouched: f?.daysUntouched ?? 0,
        assignedSource: sourceOf.get(d.id) ?? null,
        clientMonthly: d.tenant ? (monthly.get(d.tenant.id) ?? null) : null,
      };
    });
  }

  async list(q: SalesPortfoliosQuery = {}, now = new Date()): Promise<SalesPortfolioListDto> {
    const limit = Math.min(Math.max(q.limit ?? PAGE_SIZE, 1), 100);
    const base = this.baseWhere(q);
    const [{ rows, facts }, stageGroups, archived, untouched, repGroups, noRep, batchRows] =
      await Promise.all([
        this.ordered(q, now),
        this.admin.platformLead.groupBy({
          by: ['status'],
          where: { AND: [base, ACTIVE] },
          _count: { _all: true },
        }),
        this.admin.platformLead.count({ where: { AND: [base, ARCHIVED] } }),
        this.admin.platformLead.count({
          where: {
            AND: [
              base,
              ACTIVE,
              { tenantId: null, status: { in: OPEN_STAGES } },
              {
                OR: [
                  { salesProfile: { is: null } },
                  { salesProfile: { is: { lastContactAt: null } } },
                ],
              },
              { activities: { none: { type: { in: CONTACT_TYPES } } } },
            ],
          },
        }),
        this.admin.platformLead.groupBy({
          by: ['salesRepId'],
          where: { discardedAt: null, salesRepId: { not: null } },
          _count: { _all: true },
        }),
        this.admin.platformLead.count({
          where: {
            discardedAt: null,
            salesRepId: null,
            status: { in: ['new', 'contacted', 'interested', 'trial', 'customer'] },
          },
        }),
        this.admin.platformLead.groupBy({
          by: ['salesBatch'],
          where: { discardedAt: null, salesBatch: { not: null } },
          _count: { _all: true },
        }),
      ]);
    let start = 0;
    const cursor = q.cursor ? CURSOR_RE.exec(q.cursor) : null;
    if (cursor) {
      const idx = rows.findIndex((r) => r.id === cursor[2]);
      start = idx >= 0 ? idx + 1 : Math.min(Number(cursor[1]), rows.length);
    }
    const page = rows.slice(start, start + limit);
    const end = start + page.length;
    const last = page[page.length - 1];
    const funnel = Object.fromEntries(PLATFORM_LEAD_STAGES.map((s) => [s, 0])) as Record<
      PlatformLeadStage,
      number
    >;
    for (const g of stageGroups) {
      if (g.status in funnel) funnel[g.status as PlatformLeadStage] = g._count._all;
    }
    const repIds = repGroups.map((g) => g.salesRepId!).filter(Boolean);
    const reps = repIds.length
      ? await this.admin.superAdmin.findMany({
          where: { id: { in: repIds } },
          select: { id: true, fullName: true, isActive: true },
        })
      : [];
    const countOf = new Map(repGroups.map((g) => [g.salesRepId, g._count._all]));
    return {
      items: await this.rows(
        page.map((r) => r.id),
        facts,
      ),
      total: rows.length,
      nextCursor: end < rows.length && last ? `${end}_${last.id}` : null,
      funnel,
      archived,
      untouched,
      reps: reps
        .map((r) => ({
          id: r.id,
          name: r.fullName,
          isActive: r.isActive,
          count: countOf.get(r.id) ?? 0,
        }))
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name)),
      noRep,
      batches: batchRows
        .map((b) => ({ name: b.salesBatch!, count: b._count._all }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    };
  }

  /** Todas las filas para el CSV (con los mismos filtros y orden, hasta 5.000). */
  async exportRows(
    q: SalesPortfoliosQuery = {},
    now = new Date(),
  ): Promise<SalesPortfolioRowDto[]> {
    const { rows, facts } = await this.ordered(q, now);
    const ids = rows.slice(0, SALES_PORTFOLIO_EXPORT_MAX).map((r) => r.id);
    const out: SalesPortfolioRowDto[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      out.push(...(await this.rows(ids.slice(i, i + 500), facts)));
    }
    return out;
  }

  // ------------------------------------------------------------------ ficha

  private async leadOrThrow(leadId: string) {
    const lead = await this.admin.platformLead.findFirst({
      where: { id: leadId, discardedAt: null },
      select: {
        id: true,
        status: true,
        tenantId: true,
        salesRepId: true,
        salesAssignedAt: true,
        salesArchivedAt: true,
        createdAt: true,
        companyName: true,
        contactName: true,
        email: true,
        salesRep: { select: { id: true, fullName: true, isActive: true } },
      },
    });
    if (!lead) {
      throw new NotFoundException({ code: 'lead_not_found', message: 'Cuenta no encontrada' });
    }
    return lead;
  }

  async detail(leadId: string, now = new Date()): Promise<SalesPortfolioDetailDto> {
    const lead = await this.leadOrThrow(leadId);
    const [
      detail,
      profile,
      cadence,
      tenant,
      assignments,
      appointments,
      enrollments,
      wins,
      contact,
    ] = await Promise.all([
      this.leads.detail(leadId),
      this.admin.salesAccountProfile.findUnique({ where: { leadId } }),
      this.accounts.enrollmentOf(leadId),
      lead.tenantId
        ? this.admin.tenant.findUnique({
            where: { id: lead.tenantId },
            select: { salesRepId: true },
          })
        : null,
      this.admin.salesAssignment.findMany({
        where: { leadId },
        orderBy: { startedAt: 'asc' },
        include: { rep: { select: { fullName: true } } },
      }),
      this.admin.salesAppointment.findMany({
        where: { leadId },
        include: { rep: { select: { fullName: true } } },
      }),
      this.admin.salesCadenceEnrollment.findMany({
        where: { leadId },
        include: { cadence: { select: { name: true } }, rep: { select: { fullName: true } } },
      }),
      this.admin.salesRecovery.findMany({
        where: { leadId, wonAt: { not: null } },
        include: { rep: { select: { fullName: true } } },
      }),
      this.admin.platformLeadActivity.findFirst({
        where: { leadId, type: { in: CONTACT_TYPES } },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
    ]);
    const pendingAssignment = !!lead.tenantId && tenant?.salesRepId !== lead.salesRepId;
    const client = lead.tenantId ? await this.accounts.clientSheet(lead.tenantId, now) : null;
    let lastContact = profile?.lastContactAt ?? null;
    if (contact && (!lastContact || contact.occurredAt > lastContact)) {
      lastContact = contact.occurredAt;
    }
    const since = lastContact ?? lead.salesAssignedAt ?? lead.createdAt;

    // Quién asignó cada reparto (para saber si fue la dirección).
    const assignerIds = [
      ...new Set(assignments.map((a) => a.assignedById).filter((x): x is string => !!x)),
    ];
    const assigners = assignerIds.length
      ? await this.admin.superAdmin.findMany({
          where: { id: { in: assignerIds } },
          select: { id: true, fullName: true, role: true },
        })
      : [];
    const assignerOf = new Map(assigners.map((a) => [a.id, a]));

    const timeline: SalesTimelineEntryDto[] = [];
    for (const a of detail.activities) {
      const isDirection = a.type === 'direction';
      timeline.push({
        id: `activity:${a.id}`,
        at: a.occurredAt,
        kind: 'activity',
        activityType: a.type,
        title: isDirection
          ? (a.subject ?? 'Dirección')
          : a.subject
            ? `${PLATFORM_LEAD_ACTIVITY_LABELS[a.type]}: ${a.subject}`
            : PLATFORM_LEAD_ACTIVITY_LABELS[a.type],
        detail: a.content || null,
        author: a.superAdminName,
        byDirection: isDirection,
      });
    }
    const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
    for (const f of detail.followups) {
      timeline.push({
        id: `followup:${f.id}`,
        at: f.createdAt,
        kind: 'followup',
        activityType: null,
        title: `Seguimiento para el ${day(f.dueDate)}: ${f.title}`,
        detail: f.note,
        author: f.assignedToName,
        byDirection: false,
      });
      if (f.completedAt) {
        timeline.push({
          id: `followup-done:${f.id}`,
          at: f.completedAt,
          kind: 'followup',
          activityType: null,
          title: `Seguimiento hecho: ${f.title}`,
          detail: null,
          author: f.assignedToName,
          byDirection: false,
        });
      }
    }
    for (const ap of appointments) {
      const status = SALES_APPOINTMENT_STATUS_LABELS[ap.status as SalesAppointmentStatus];
      timeline.push({
        id: `appointment:${ap.id}`,
        at: ap.startsAt.toISOString(),
        kind: 'appointment',
        activityType: null,
        title: `Cita (${SALES_APPOINTMENT_KIND_LABELS[ap.kind as SalesAppointmentKind] ?? ap.kind}): ${ap.title}`,
        detail: [status, ap.location, ap.notes].filter(Boolean).join(' · ') || null,
        author: ap.rep.fullName,
        byDirection: false,
      });
    }
    for (const o of detail.quoteOffers) {
      const state =
        o.status === 'accepted'
          ? 'Aceptada'
          : o.status === 'rejected'
            ? 'Rechazada'
            : o.expired
              ? 'Caducada'
              : o.openedAt
                ? `Abierta ${o.openCount} ${o.openCount === 1 ? 'vez' : 'veces'}`
                : 'Sin abrir';
      timeline.push({
        id: `quote:${o.id}`,
        at: o.createdAt,
        kind: 'quote',
        activityType: null,
        title: `Propuesta: ${o.planName} · ${o.total.toFixed(2).replace('.', ',')} €`,
        detail: state,
        author: o.superAdminName,
        byDirection: false,
      });
    }
    for (const e of enrollments) {
      timeline.push({
        id: `cadence:${e.id}`,
        at: e.startedAt.toISOString(),
        kind: 'cadence',
        activityType: null,
        title: `Cadencia «${e.cadence.name}» iniciada`,
        detail: null,
        author: e.rep.fullName,
        byDirection: false,
      });
      if (e.finishedAt) {
        timeline.push({
          id: `cadence-end:${e.id}`,
          at: e.finishedAt.toISOString(),
          kind: 'cadence',
          activityType: null,
          title: `Cadencia «${e.cadence.name}» ${e.status === 'stopped' ? 'parada' : 'terminada'}`,
          detail: null,
          author: e.rep.fullName,
          byDirection: false,
        });
      }
    }
    for (const a of assignments) {
      const by = a.assignedById ? assignerOf.get(a.assignedById) : undefined;
      const byDirection = !!by && by.role !== 'sales';
      timeline.push({
        id: `assignment:${a.id}`,
        at: a.startedAt.toISOString(),
        kind: 'assignment',
        activityType: null,
        title: `Lo lleva ${a.rep.fullName}`,
        detail: SALES_SOURCE_LABELS[a.source] ?? a.source,
        author: by?.fullName ?? null,
        byDirection,
      });
      if (a.endedAt) {
        timeline.push({
          id: `assignment-end:${a.id}`,
          at: a.endedAt.toISOString(),
          kind: 'assignment',
          activityType: null,
          title: `Deja de llevarlo ${a.rep.fullName}`,
          detail: a.endedReason ? (ENDED_LABELS[a.endedReason] ?? a.endedReason) : null,
          author: null,
          byDirection: false,
        });
      }
    }
    for (const w of wins) {
      timeline.push({
        id: `recovery-won:${w.id}`,
        at: w.wonAt!.toISOString(),
        kind: 'archive',
        activityType: null,
        title: 'Vuelve a contratar tras recuperarlo',
        detail: null,
        author: w.rep.fullName,
        byDirection: false,
      });
    }
    timeline.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));

    const open = assignments.find((a) => !a.endedAt);
    return {
      account: {
        lead: detail,
        profile: profileDto(profile),
        client,
        cadence,
        pendingAssignment,
      },
      rep: lead.salesRep
        ? {
            id: lead.salesRep.id,
            fullName: lead.salesRep.fullName,
            isActive: lead.salesRep.isActive,
          }
        : null,
      assignedAt: lead.salesAssignedAt?.toISOString() ?? null,
      assignedSource: open?.source ?? null,
      lastContactAt: lastContact?.toISOString() ?? null,
      neverContacted: !lastContact,
      daysUntouched: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY)),
      timeline,
    };
  }

  // -------------------------------------------------------- acciones de la dirección

  private leadActor(actor: DirectionActor) {
    return {
      superAdminId: actor.superAdminId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    };
  }

  private async directionNote(
    leadId: string,
    byId: string,
    subject: string,
    content: string,
  ): Promise<void> {
    await this.admin.platformLeadActivity.create({
      data: { leadId, superAdminId: byId, type: 'direction', subject, content },
    });
  }

  /**
   * Lo que acaba de anotar el sistema por una acción de la dirección (cambio
   * de fase, archivo…) pasa a ser «de la dirección»: así consta quién lo hizo
   * y no cuenta como trabajo del comercial.
   */
  private async markAsDirection(leadId: string, byId: string, since: Date): Promise<void> {
    const rows = await this.admin.platformLeadActivity.findMany({
      where: { leadId, superAdminId: byId, type: 'system', createdAt: { gte: since } },
      select: { id: true, content: true },
    });
    for (const r of rows) {
      await this.admin.platformLeadActivity.update({
        where: { id: r.id },
        data: { type: 'direction', subject: 'Cambio de la dirección', content: r.content },
      });
    }
  }

  private async record(
    actor: DirectionActor,
    action: string,
    lead: { id: string; tenantId: string | null },
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: `admin.sales.direction_${action}`,
      targetType: lead.tenantId ? 'tenant' : 'platform_lead',
      targetId: lead.tenantId ?? lead.id,
      targetTenantId: lead.tenantId,
      changes: { leadId: lead.id, byDirection: true, ...changes },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  private async tellRep(
    lead: { id: string; salesRepId: string | null; salesRep: { isActive: boolean } | null },
    title: string,
    body: string | null,
  ): Promise<boolean> {
    if (!lead.salesRepId || !lead.salesRep?.isActive) return false;
    await this.notify.rep(lead.salesRepId, {
      type: 'sales.direction',
      title,
      body,
      link: `/admin/sales/accounts/${lead.id}`,
    });
    return true;
  }

  /** Nota de la dirección al comercial: queda en la cronología y le llega un aviso. */
  async addNote(
    leadId: string,
    input: SalesDirectionNoteInput,
    actor: DirectionActor,
  ): Promise<SalesPortfolioDetailDto> {
    const lead = await this.leadOrThrow(leadId);
    await this.directionNote(leadId, actor.superAdminId, 'Nota de la dirección', input.content);
    const notified = await this.tellRep(
      lead,
      `Nota de la dirección sobre ${platformLeadName(lead)}`,
      input.content,
    );
    await this.record(actor, 'note', lead, { notified, length: input.content.length });
    return this.detail(leadId);
  }

  /** Pasa la cuenta a otro comercial o la deja sin comercial. */
  async reassign(
    leadId: string,
    input: SalesDirectionReassignInput,
    actor: DirectionActor,
  ): Promise<SalesPortfolioDetailDto> {
    const lead = await this.leadOrThrow(leadId);
    if (input.repId === lead.salesRepId) {
      throw new BadRequestException({
        code: 'same_rep',
        message: input.repId ? 'Ya lo lleva ese comercial' : 'Ya está sin comercial',
      });
    }
    const target = input.repId
      ? await this.admin.superAdmin.findFirst({
          where: { id: input.repId, role: 'sales', isActive: true },
          select: { id: true, fullName: true },
        })
      : null;
    if (input.repId && !target) {
      throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
    }
    await this.assignment.assign({
      leadId,
      repId: input.repId,
      source: 'manual',
      byId: actor.superAdminId,
    });
    const from = lead.salesRep?.fullName ?? null;
    await this.directionNote(
      leadId,
      actor.superAdminId,
      'Cambio de la dirección',
      target
        ? from
          ? `Pasa de ${from} a ${target.fullName}`
          : `Se la da a ${target.fullName}`
        : `Deja de llevarlo ${from ?? 'nadie'}: queda sin comercial`,
    );
    if (lead.salesRepId && lead.salesRep?.isActive) {
      await this.notify.rep(lead.salesRepId, {
        type: 'sales.unassigned',
        title: `${platformLeadName(lead)} ya no está en tu cartera`,
        body: target
          ? `La dirección se lo ha pasado a ${target.fullName}.`
          : 'Lo ha retirado la dirección.',
        link: null,
      });
    }
    await this.record(actor, 'reassigned', lead, {
      fromRepId: lead.salesRepId,
      toRepId: input.repId,
    });
    return this.detail(leadId);
  }

  /** Edita la ficha comercial (sin tocar el último contacto). */
  async updateProfile(
    leadId: string,
    input: UpdateSalesProfileInput,
    actor: DirectionActor,
  ): Promise<SalesPortfolioDetailDto> {
    const lead = await this.leadOrThrow(leadId);
    const before = await this.admin.salesAccountProfile.findUnique({ where: { leadId } });
    const data = {
      ...(input.pinnedNote !== undefined ? { pinnedNote: clean(input.pinnedNote) } : {}),
      ...(input.status !== undefined ? { status: clean(input.status) } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.decisionMaker !== undefined ? { decisionMaker: clean(input.decisionMaker) } : {}),
      ...(input.bestTime !== undefined ? { bestTime: clean(input.bestTime) } : {}),
      ...(input.nextAction !== undefined ? { nextAction: clean(input.nextAction) } : {}),
    };
    const changed = (Object.keys(data) as (keyof typeof data)[]).filter(
      (k) => (before?.[k] ?? null) !== (data[k] ?? null),
    );
    if (changed.length === 0) return this.detail(leadId);
    await this.admin.salesAccountProfile.upsert({
      where: { leadId },
      create: { leadId, ...data, updatedById: actor.superAdminId },
      update: { ...data, updatedById: actor.superAdminId },
    });
    const describe = (k: (typeof changed)[number]) => {
      const v = data[k];
      if (k === 'temperature') {
        return `${PROFILE_FIELD_LABELS[k]}: ${v ? SALES_TEMPERATURE_LABELS[v as keyof typeof SALES_TEMPERATURE_LABELS] : 'sin indicar'}`;
      }
      return `${PROFILE_FIELD_LABELS[k]}: ${v ? `«${v}»` : 'vacío'}`;
    };
    const text = `Ficha comercial editada. ${changed.map(describe).join('; ')}`;
    await this.directionNote(leadId, actor.superAdminId, 'Cambio de la dirección', text);
    await this.tellRep(lead, `La dirección ha editado la ficha de ${platformLeadName(lead)}`, text);
    await this.record(actor, 'profile_updated', lead, { fields: changed });
    return this.detail(leadId);
  }

  /** Mueve de fase (las de una cuenta las marca su cuenta). */
  async move(
    leadId: string,
    input: MovePlatformLeadInput,
    actor: DirectionActor,
  ): Promise<SalesPortfolioDetailDto> {
    const lead = await this.leadOrThrow(leadId);
    if (lead.status === input.status) return this.detail(leadId);
    const since = new Date(Date.now() - 2000);
    await this.leads.move(leadId, input, this.leadActor(actor));
    await this.markAsDirection(leadId, actor.superAdminId, since);
    await this.tellRep(
      lead,
      `La dirección ha movido ${platformLeadName(lead)} a ${PLATFORM_LEAD_STAGE_LABELS[input.status]}`,
      null,
    );
    await this.record(actor, 'moved', lead, { from: lead.status, to: input.status });
    return this.detail(leadId);
  }

  /** «No interesado»: lo archiva en la cartera de su comercial. */
  async archive(
    leadId: string,
    input: SalesArchiveLeadInput,
    actor: DirectionActor,
  ): Promise<SalesPortfolioDetailDto> {
    const lead = await this.leadOrThrow(leadId);
    if (lead.status === 'lost' && lead.salesArchivedAt) {
      throw new BadRequestException({ code: 'already_archived', message: 'Ya está archivado' });
    }
    const since = new Date(Date.now() - 2000);
    await this.leads.lose(
      leadId,
      { reasonCode: input.reasonCode, ...(input.reason ? { reason: input.reason } : {}) },
      this.leadActor(actor),
      { recoverOn: input.recoverOn, doNotContact: input.doNotContact ?? false },
    );
    await this.markAsDirection(leadId, actor.superAdminId, since);
    await this.tellRep(lead, `La dirección ha archivado ${platformLeadName(lead)}`, null);
    await this.record(actor, 'archived', lead, {
      reasonCode: input.reasonCode,
      recoverOn: input.recoverOn ?? null,
      doNotContact: input.doNotContact ?? false,
    });
    return this.detail(leadId);
  }

  /** «Recuperar»: vuelve a la cartera activa de su comercial con todo su historial. */
  async recover(leadId: string, actor: DirectionActor): Promise<SalesPortfolioDetailDto> {
    const lead = await this.leadOrThrow(leadId);
    if (lead.status !== 'lost') {
      throw new BadRequestException({ code: 'not_archived', message: 'No está archivado' });
    }
    const since = new Date(Date.now() - 2000);
    if (lead.salesRepId && lead.salesArchivedAt) {
      await this.recovery.recover(lead.salesRepId, leadId, {
        repId: actor.superAdminId,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
    } else {
      await this.leads.reopen(leadId, this.leadActor(actor));
    }
    await this.markAsDirection(leadId, actor.superAdminId, since);
    await this.tellRep(lead, `La dirección ha recuperado ${platformLeadName(lead)}`, null);
    await this.record(actor, 'recovered', lead, {});
    return this.detail(leadId);
  }

  // ------------------------------------------------------------------ avisos

  /**
   * Aviso a la dirección de los prospectos que repartió (en un reparto o a
   * mano) con los que su comercial no ha hablado en los días de las Reglas del
   * equipo. Cada prospecto se avisa una vez por reparto. Devuelve cuántos.
   */
  async warnFirstContact(now = new Date()): Promise<number> {
    const settings = await this.assignment.settings();
    const days = settings.firstContactAlertDays;
    if (days <= 0) return 0;
    const cutoff = new Date(now.getTime() - days * DAY);
    const candidates = await this.admin.platformLead.findMany({
      where: {
        discardedAt: null,
        tenantId: null,
        salesRepId: { not: null },
        salesRep: { isActive: true },
        status: { in: OPEN_STAGES },
        salesAssignedAt: { lte: cutoff },
        salesAssignments: {
          some: {
            endedAt: null,
            source: { in: ['direction', 'manual'] },
            assignedById: { not: null },
          },
        },
      },
      select: {
        id: true,
        companyName: true,
        contactName: true,
        email: true,
        salesAssignedAt: true,
        salesFirstContactWarnedAt: true,
        salesRep: { select: { fullName: true } },
        salesProfile: { select: { lastContactAt: true } },
        activities: {
          where: { type: { in: CONTACT_TYPES } },
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { occurredAt: true },
        },
      },
      orderBy: { salesAssignedAt: 'asc' },
      take: 2000,
    });
    const due = candidates.filter((l) => {
      const assigned = l.salesAssignedAt!;
      if (l.salesFirstContactWarnedAt && l.salesFirstContactWarnedAt >= assigned) return false;
      const lastContact = l.salesProfile?.lastContactAt;
      if (lastContact && lastContact >= assigned) return false;
      const lastActivity = l.activities[0]?.occurredAt;
      return !(lastActivity && lastActivity >= assigned);
    });
    if (due.length === 0) return 0;
    await this.admin.platformLead.updateMany({
      where: { id: { in: due.map((l) => l.id) } },
      data: { salesFirstContactWarnedAt: now },
    });
    const shown = due.slice(0, ALERT_SHOWN).map((l) => {
      const d = Math.floor((now.getTime() - l.salesAssignedAt!.getTime()) / DAY);
      return `· ${platformLeadName(l)} (${l.salesRep?.fullName ?? 'sin comercial'}, hace ${d} días)`;
    });
    const more = due.length > shown.length ? [`… y ${due.length - shown.length} más.`] : [];
    await this.notify.team({
      type: 'sales.first_contact_missing',
      title:
        due.length === 1
          ? `Un prospecto que repartiste sigue sin primer contacto`
          : `${due.length} prospectos que repartiste siguen sin primer contacto`,
      body: [
        `Su comercial no ha hablado con ellos en ${days} días desde que se los diste:`,
        ...shown,
        ...more,
      ].join('\n'),
      link: '/admin/sales-team/portfolios?never=1',
    });
    return due.length;
  }
}
