import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  platformLeadName,
  SALES_HOT_NO_CONTACT_DAYS,
  SALES_LEAD_SORT_DEFAULT_DIR,
  SALES_QUEUE_REASON_LABELS,
  SALES_QUEUE_REASONS,
  SALES_TRIAL_ENDING_DAYS,
  salesLeadSize,
  type PlatformLeadDto,
  type SalesBulkLeadActionInput,
  type SalesBulkLeadResultDto,
  type SalesLeadDto,
  type SalesLeadListDto,
  type SalesLeadsQuery,
  type SalesLeadSort,
  type SalesQueueDto,
  type SalesQueueItemDto,
  type SalesQueueReason,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PlatformLeadsService } from '../leads/platform-leads.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAccountsService } from './sales-accounts.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { DAY, daysUntil, madridToday, profileDto, type SalesActor } from './sales-common';

/** Sin contacto anotado en estos días: «Sin contacto hace tiempo». */
const NO_CONTACT_DAYS = 14;
/** Actividades que cuentan como haber hablado con él. */
const CONTACT_ACTIVITY_TYPES = ['call', 'whatsapp', 'meeting', 'demo', 'email_out'];
const PAGE_SIZE = 50;
/** Lo que trae la cola «Por hacer» como mucho. */
const QUEUE_MAX = 150;
/** Nuevos sin tocar que entran en la cola (los de más valor). */
const QUEUE_UNTOUCHED_MAX = 50;
const CURSOR_RE = /^(\d{1,7})_([0-9a-f-]{36})$/i;

interface LightRow {
  id: string;
  status: string;
  source: string;
  units: string | null;
  facilities: string | null;
  planSlug: string | null;
  createdAt: Date;
  updatedAt: Date;
  salesAssignedAt: Date | null;
  salesProfile: { lastContactAt: Date | null } | null;
}

const LIGHT_SELECT = {
  id: true,
  status: true,
  source: true,
  units: true,
  facilities: true,
  planSlug: true,
  createdAt: true,
  updatedAt: true,
  salesAssignedAt: true,
  salesProfile: { select: { lastContactAt: true } },
} satisfies Prisma.PlatformLeadSelect;

/**
 * La cartera del comercial para trabajarla: la lista por páginas con su orden
 * y sus filtros, la cola «Por hacer» y las acciones en lote. Todo se limita a
 * sus leads: lo de otro comercial no existe para él.
 */
@Injectable()
export class SalesPortfolioService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly leads: PlatformLeadsService,
    private readonly assignment: SalesAssignmentService,
    private readonly accounts: SalesAccountsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ------------------------------------------------------------------ lista

  /** Filtros que se pueden hacer en la consulta. */
  private leadWhere(repId: string, q: SalesLeadsQuery, now: Date): Prisma.PlatformLeadWhereInput {
    const and: Prisma.PlatformLeadWhereInput[] = [];
    const where: Prisma.PlatformLeadWhereInput = { salesRepId: repId, discardedAt: null };
    if (q.status) where.status = q.status;
    if (q.batch) where.salesBatch = { equals: q.batch, mode: 'insensitive' };
    if (q.city) where.city = { equals: q.city, mode: 'insensitive' };
    if (q.temperature === 'none') {
      and.push({
        OR: [{ salesProfile: { is: null } }, { salesProfile: { is: { temperature: null } } }],
      });
    } else if (q.temperature) {
      and.push({ salesProfile: { is: { temperature: q.temperature } } });
    }
    if (q.search) {
      const contains = { contains: q.search, mode: 'insensitive' as const };
      and.push({
        OR: [
          { companyName: contains },
          { contactName: contains },
          { email: contains },
          { phone: contains },
          { city: contains },
        ],
      });
    }
    const cutoff = new Date(now.getTime() - NO_CONTACT_DAYS * DAY);
    switch (q.filter) {
      case 'new_for_you':
        where.salesSeenAt = null;
        break;
      case 'untouched':
        and.push(this.untouchedWhere(repId));
        break;
      case 'no_contact':
        and.push(
          { status: { notIn: ['customer', 'lost'] } },
          {
            OR: [
              { salesProfile: { is: { lastContactAt: { lt: cutoff } } } },
              {
                AND: [
                  {
                    OR: [
                      { salesProfile: { is: null } },
                      { salesProfile: { is: { lastContactAt: null } } },
                    ],
                  },
                  {
                    activities: { none: { occurredAt: { gte: cutoff }, type: { not: 'system' } } },
                  },
                ],
              },
            ],
          },
        );
        break;
      case 'trial_ending':
        and.push({
          tenant: {
            status: 'trial',
            deletedAt: null,
            trialEndsAt: { lte: new Date(now.getTime() + SALES_TRIAL_ENDING_DAYS * DAY) },
          },
        });
        break;
      case 'pending':
        and.push(
          { tenantId: { not: null } },
          { tenant: { OR: [{ salesRepId: null }, { salesRepId: { not: repId } }] } },
        );
        break;
      default:
        break;
    }
    if (and.length > 0) where.AND = and;
    return where;
  }

  /** Prospecto abierto (sin cuenta) con el que el comercial aún no ha hablado. */
  private untouchedWhere(repId: string): Prisma.PlatformLeadWhereInput {
    return {
      status: { in: ['new', 'contacted', 'interested'] },
      OR: [{ salesProfile: { is: null } }, { salesProfile: { is: { lastContactAt: null } } }],
      activities: { none: { type: { in: CONTACT_ACTIVITY_TYPES }, superAdminId: repId } },
    };
  }

  /**
   * Su cartera por páginas: los filtros van en la consulta (el tamaño, que es
   * texto libre, se calcula) y el orden se hace sobre todos los que cumplen.
   */
  async listLeads(
    repId: string,
    q: SalesLeadsQuery = {},
    now = new Date(),
    maxLimit = 100,
  ): Promise<SalesLeadListDto> {
    const limit = Math.min(Math.max(q.limit ?? PAGE_SIZE, 1), maxLimit);
    const sort: SalesLeadSort = q.sort ?? 'updated';
    const dir = q.dir ?? SALES_LEAD_SORT_DEFAULT_DIR[sort];
    const where = this.leadWhere(repId, q, now);
    const [rows, groups, newForYou, batchRows, cityRows] = await Promise.all([
      this.admin.platformLead.findMany({ where, select: LIGHT_SELECT }),
      this.admin.platformLead.groupBy({
        by: ['status'],
        where: { salesRepId: repId, discardedAt: null },
        _count: { _all: true },
      }),
      this.admin.platformLead.count({
        where: { salesRepId: repId, discardedAt: null, salesSeenAt: null },
      }),
      this.admin.platformLead.groupBy({
        by: ['salesBatch'],
        where: { salesRepId: repId, discardedAt: null, salesBatch: { not: null } },
        _count: { _all: true },
      }),
      this.admin.platformLead.groupBy({
        by: ['city'],
        where: { salesRepId: repId, discardedAt: null, city: { not: null } },
        _count: { _all: true },
      }),
    ]);
    let matching: LightRow[] = rows;
    if (q.size) matching = matching.filter((r) => salesLeadSize(r.units) === q.size);
    const ordered = await this.sortRows(matching, sort, dir, now);
    // El cursor dice dónde se quedó: tras el último que vio (si sigue) o en su posición.
    let start = 0;
    const cursor = q.cursor ? CURSOR_RE.exec(q.cursor) : null;
    if (cursor) {
      const idx = ordered.findIndex((r) => r.id === cursor[2]);
      start = idx >= 0 ? idx + 1 : Math.min(Number(cursor[1]), ordered.length);
    }
    const page = ordered.slice(start, start + limit);
    const end = start + page.length;
    const last = page[page.length - 1];
    const items = await this.dtosInOrder(page.map((r) => r.id));
    const counts: Record<string, number> = {};
    for (const g of groups) counts[g.status] = g._count._all;
    return {
      items,
      counts,
      newForYou,
      batches: batchRows
        .map((b) => ({ name: b.salesBatch!, count: b._count._all }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
      cities: mergeCities(cityRows.map((c) => ({ name: c.city!, count: c._count._all }))),
      total: ordered.length,
      nextCursor: end < ordered.length && last ? `${end}_${last.id}` : null,
    };
  }

  private async sortRows(
    rows: LightRow[],
    sort: SalesLeadSort,
    dir: 'asc' | 'desc',
    now: Date,
  ): Promise<LightRow[]> {
    const sign = dir === 'asc' ? 1 : -1;
    const ranks =
      sort === 'priority' || sort === 'value' || sort === 'last_contact'
        ? await this.leads.rankRows(rows, now)
        : null;
    const time = (d: Date | null | undefined) => (d ? d.getTime() : null);
    const key = (r: LightRow): number | null => {
      const rank = ranks?.get(r.id);
      switch (sort) {
        case 'priority':
          return rank?.score ?? 0;
        case 'value':
          return rank?.monthly ?? null;
        case 'last_contact':
          // Sin contacto: el más antiguo de todos.
          return time(r.salesProfile?.lastContactAt ?? rank?.lastActivityAt) ?? 0;
        case 'assigned':
          return time(r.salesAssignedAt);
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
        return (ka - kb) * sign;
      }
      // Desempate: a igual prioridad o valor, el otro dato; luego el más reciente.
      if (sort === 'priority' || sort === 'value') {
        const ra = ranks?.get(a.id);
        const rb = ranks?.get(b.id);
        const other =
          sort === 'priority'
            ? (rb?.monthly ?? 0) - (ra?.monthly ?? 0)
            : (rb?.score ?? 0) - (ra?.score ?? 0);
        if (other !== 0) return other;
      }
      return b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1);
    });
  }

  /** Fichas de la lista en el orden de `ids`, con su ficha comercial y su cuenta. */
  private async dtosInOrder(ids: string[]): Promise<SalesLeadDto[]> {
    if (ids.length === 0) return [];
    const dtos = await this.leads.listDtos({ id: { in: ids } }, ids.length);
    const enriched = await this.enrich(dtos);
    const byId = new Map(enriched.map((d) => [d.id, d]));
    return ids.map((id) => byId.get(id)).filter((d): d is SalesLeadDto => !!d);
  }

  async enrich(dtos: PlatformLeadDto[]): Promise<SalesLeadDto[]> {
    const ids = dtos.map((d) => d.id);
    const tenantIds = dtos.map((d) => d.tenant?.id).filter((x): x is string => !!x);
    const [profiles, tenants, assigned] = await Promise.all([
      ids.length ? this.admin.salesAccountProfile.findMany({ where: { leadId: { in: ids } } }) : [],
      tenantIds.length
        ? this.admin.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, status: true },
          })
        : [],
      ids.length
        ? this.admin.platformLead.findMany({
            where: { id: { in: ids } },
            select: { id: true, salesAssignedAt: true },
          })
        : [],
    ]);
    const assignedOf = new Map(assigned.map((a) => [a.id, a.salesAssignedAt]));
    const profileOf = new Map(profiles.map((p) => [p.leadId, p]));
    const tenantOf = new Map(tenants.map((t) => [t.id, t]));
    return dtos.map((d) => ({
      ...d,
      salesProfile: profileDto(profileOf.get(d.id)),
      tenantStatus: d.tenant ? (tenantOf.get(d.tenant.id)?.status ?? null) : null,
      salesAssignedAt: assignedOf.get(d.id)?.toISOString() ?? null,
    }));
  }

  // -------------------------------------------------------------- «Por hacer»

  /**
   * Lo que toca hacer, en orden: seguimientos atrasados y de hoy, nuevos sin
   * tocar (los de más valor primero), calientes con los que no habla desde
   * hace días y pruebas que acaban. Cada lead sale una vez, con su motivo.
   */
  async queue(repId: string, now = new Date()): Promise<SalesQueueDto> {
    const today = madridToday(now);
    const todayDate = new Date(`${today}T00:00:00Z`);
    const hotCutoff = new Date(now.getTime() - SALES_HOT_NO_CONTACT_DAYS * DAY);
    const trialLimit = new Date(now.getTime() + SALES_TRIAL_ENDING_DAYS * DAY);
    const mine = { salesRepId: repId, discardedAt: null } satisfies Prisma.PlatformLeadWhereInput;
    const [followups, untouched, hot, trials] = await Promise.all([
      this.admin.platformLeadFollowup.findMany({
        where: { status: 'pending', dueDate: { lte: todayDate }, lead: mine },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        take: 500,
        select: { id: true, leadId: true, title: true, dueDate: true },
      }),
      this.admin.platformLead.findMany({
        where: { ...mine, ...this.untouchedWhere(repId) },
        select: LIGHT_SELECT,
        take: 2000,
      }),
      this.admin.platformLead.findMany({
        where: {
          ...mine,
          status: { notIn: ['customer', 'lost'] },
          salesProfile: {
            is: {
              temperature: 'hot',
              OR: [{ lastContactAt: null }, { lastContactAt: { lt: hotCutoff } }],
            },
          },
        },
        select: { id: true, salesProfile: { select: { lastContactAt: true } } },
        take: 500,
      }),
      this.admin.platformLead.findMany({
        where: {
          ...mine,
          tenant: {
            salesRepId: repId,
            deletedAt: null,
            status: 'trial',
            trialEndsAt: { lte: trialLimit },
          },
        },
        select: { id: true, tenant: { select: { trialEndsAt: true } } },
        take: 500,
      }),
    ]);

    const ranks = await this.leads.rankRows(untouched, now);
    const untouchedSorted = [...untouched].sort((a, b) => {
      const ra = ranks.get(a.id);
      const rb = ranks.get(b.id);
      return (
        (rb?.monthly ?? -1) - (ra?.monthly ?? -1) ||
        (rb?.score ?? 0) - (ra?.score ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime()
      );
    });

    const counts = Object.fromEntries(SALES_QUEUE_REASONS.map((r) => [r, 0])) as Record<
      SalesQueueReason,
      number
    >;
    type Entry = Omit<SalesQueueItemDto, 'lead'> & { leadId: string };
    const entries: Entry[] = [];
    const seen = new Set<string>();
    const push = (e: Entry) => {
      counts[e.reason] += 1;
      if (seen.has(e.leadId)) return;
      seen.add(e.leadId);
      entries.push(e);
    };
    const label = (r: SalesQueueReason, extra: string) =>
      `${SALES_QUEUE_REASON_LABELS[r]}${extra ? `: ${extra}` : ''}`;

    for (const f of followups) {
      const overdue = f.dueDate.getTime() < todayDate.getTime();
      const reason: SalesQueueReason = overdue ? 'followup_overdue' : 'followup_today';
      push({
        leadId: f.leadId,
        reason,
        detail: label(reason, f.title),
        date: f.dueDate.toISOString().slice(0, 10),
        followupId: f.id,
      });
    }
    let untouchedIn = 0;
    for (const r of untouchedSorted) {
      const monthly = ranks.get(r.id)?.monthly;
      if (untouchedIn >= QUEUE_UNTOUCHED_MAX) {
        counts.new_untouched += 1;
        continue;
      }
      if (!seen.has(r.id)) untouchedIn += 1;
      push({
        leadId: r.id,
        reason: 'new_untouched',
        detail: label(
          'new_untouched',
          monthly ? `unos ${Math.round(monthly)} € al mes previstos` : 'aún no has hablado con él',
        ),
        date: r.salesAssignedAt?.toISOString() ?? null,
        followupId: null,
      });
    }
    const hotSorted = [...hot].sort(
      (a, b) =>
        (a.salesProfile?.lastContactAt?.getTime() ?? 0) -
        (b.salesProfile?.lastContactAt?.getTime() ?? 0),
    );
    for (const h of hotSorted) {
      const last = h.salesProfile?.lastContactAt;
      const days = last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null;
      push({
        leadId: h.id,
        reason: 'hot_no_contact',
        detail: label(
          'hot_no_contact',
          days !== null ? `sin hablar desde hace ${days} días` : 'aún no has hablado con él',
        ),
        date: last?.toISOString() ?? null,
        followupId: null,
      });
    }
    const trialsSorted = [...trials].sort(
      (a, b) => (a.tenant?.trialEndsAt?.getTime() ?? 0) - (b.tenant?.trialEndsAt?.getTime() ?? 0),
    );
    for (const t of trialsSorted) {
      const left = daysUntil(t.tenant?.trialEndsAt, now);
      push({
        leadId: t.id,
        reason: 'trial_ending',
        detail: label(
          'trial_ending',
          left === null
            ? ''
            : left <= 0
              ? 'acaba hoy'
              : `le quedan ${left} ${left === 1 ? 'día' : 'días'}`,
        ),
        date: t.tenant?.trialEndsAt?.toISOString() ?? null,
        followupId: null,
      });
    }

    const kept = entries.slice(0, QUEUE_MAX);
    const leads = await this.dtosInOrder(kept.map((e) => e.leadId));
    const byId = new Map(leads.map((l) => [l.id, l]));
    const items: SalesQueueItemDto[] = [];
    for (const { leadId, ...rest } of kept) {
      const lead = byId.get(leadId);
      if (lead) items.push({ lead, ...rest });
    }
    return {
      items,
      counts,
      truncated: entries.length > QUEUE_MAX || untouched.length > QUEUE_UNTOUCHED_MAX,
    };
  }

  // ------------------------------------------------------- acciones en lote

  /**
   * La misma acción a varios de su cartera. Cada uno va por su lado: el que
   * falla (no es suyo, ya tiene cuenta…) sale en `failed` y el resto se hace.
   */
  async bulk(
    repId: string,
    input: SalesBulkLeadActionInput,
    actor: SalesActor,
  ): Promise<SalesBulkLeadResultDto> {
    const { action } = input;
    const leadActor = {
      superAdminId: actor.repId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    };
    if (action.type === 'cadence') {
      const cadence = await this.admin.salesCadence.findFirst({
        where: { id: action.cadenceId, isActive: true },
        select: { id: true },
      });
      if (!cadence) {
        throw new NotFoundException({
          code: 'cadence_not_found',
          message: 'Cadencia no encontrada',
        });
      }
    }
    const ids = [...new Set(input.leadIds)];
    let done = 0;
    const failed: SalesBulkLeadResultDto['failed'] = [];
    for (const leadId of ids) {
      let name: string | null = null;
      try {
        const lead = await this.assignment.leadOf(repId, leadId);
        name = platformLeadName(lead);
        switch (action.type) {
          case 'followup':
            await this.leads.createFollowup(
              leadId,
              {
                title: action.title,
                dueDate: action.dueDate,
                ...(action.note ? { note: action.note } : {}),
                assignedToId: repId,
              },
              leadActor,
            );
            break;
          case 'cadence':
            await this.accounts.startCadence(repId, leadId, action.cadenceId, actor);
            break;
          case 'move':
            await this.leads.move(leadId, { status: action.status }, leadActor);
            break;
          case 'lose':
            await this.leads.lose(
              leadId,
              {
                reasonCode: action.reasonCode,
                ...(action.reason ? { reason: action.reason } : {}),
              },
              leadActor,
            );
            break;
        }
        await this.assignment.markSeen(repId, leadId);
        done += 1;
      } catch (err) {
        failed.push({ leadId, name, message: errorMessage(err) });
      }
    }
    await this.audit.record({
      superAdminId: repId,
      action: 'admin.sales.bulk_action',
      targetType: 'platform_lead',
      targetId: null,
      changes: { type: action.type, requested: ids.length, done, failed: failed.length },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return { done, failed };
  }
}

/** Ciudades sin repetir por mayúsculas o espacios, de más a menos. */
function mergeCities(rows: { name: string; count: number }[]) {
  const byKey = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase('es');
    const prev = byKey.get(key);
    if (prev) prev.count += r.count;
    else byKey.set(key, { name, count: r.count });
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'),
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    if (typeof res === 'object' && res && 'message' in res) {
      const m = (res as { message: unknown }).message;
      if (typeof m === 'string') return m;
      if (Array.isArray(m)) return m.join(', ');
    }
    return err.message;
  }
  return 'No se ha podido hacer';
}
