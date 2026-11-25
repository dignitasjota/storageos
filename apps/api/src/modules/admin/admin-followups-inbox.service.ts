import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  FOLLOWUP_DONE_WINDOW_DAYS,
  addDaysToDay,
  platformLeadName,
  type AdminFollowupInboxDto,
  type AdminFollowupItemDto,
  type AdminFollowupKind,
  type AdminFollowupTab,
  type BulkAdminFollowupsInput,
  type BulkAdminFollowupsResultDto,
  type CreateAdminFollowupInput,
  type UpdateAdminFollowupInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { PlatformLeadsService } from './leads/platform-leads.service';
import { madridToday } from './sales/sales-common';
import { SuperAdminAuditService } from './super-admin-audit.service';

const DAY = 86_400_000;
/** Lo que cabe en una pestaña de la bandeja (de cada tipo). */
const INBOX_LIMIT = 200;

export interface FollowupActor {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface FollowupInboxFilters {
  tab: AdminFollowupTab;
  search?: string | undefined;
  /** Id de un super admin, `none` (sin asignar) o nada. */
  assignedTo?: string | undefined;
  kind?: AdminFollowupKind | undefined;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * Bandeja unificada de seguimientos del panel admin: los de los tenants y los
 * de los leads juntos, por pestañas (hoy, atrasados, próximos, hechos), con
 * búsqueda, filtro por responsable y acciones en lote. Los de los prospectos
 * de los comerciales no salen (los lleva el comercial; la dirección los ve en
 * Carteras).
 */
@Injectable()
export class AdminFollowupsInboxService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenantFollowups: AdminTenantFollowupsService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly leads: PlatformLeadsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ---------------------------------------------------------------- filtros

  private tabWhere(tab: AdminFollowupTab, now: Date) {
    const today = asDate(madridToday(now));
    switch (tab) {
      case 'today':
        return { status: 'pending', dueDate: today };
      case 'overdue':
        return { status: 'pending', dueDate: { lt: today } };
      case 'upcoming':
        return { status: 'pending', dueDate: { gt: today } };
      case 'done':
        return {
          status: 'done',
          completedAt: { gte: new Date(now.getTime() - FOLLOWUP_DONE_WINDOW_DAYS * DAY) },
        };
    }
  }

  private assignedWhere(assignedTo: string | undefined) {
    if (!assignedTo) return {};
    return assignedTo === 'none' ? { assignedToId: null } : { assignedToId: assignedTo };
  }

  private tenantWhere(f: FollowupInboxFilters, now: Date): Prisma.TenantFollowupWhereInput {
    const search = f.search?.trim();
    return {
      ...this.tabWhere(f.tab, now),
      ...this.assignedWhere(f.assignedTo),
      tenant: { deletedAt: null },
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { note: { contains: search, mode: 'insensitive' } },
              { tenant: { name: { contains: search, mode: 'insensitive' } } },
              { tenant: { slug: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  private leadWhere(f: FollowupInboxFilters, now: Date): Prisma.PlatformLeadFollowupWhereInput {
    const search = f.search?.trim();
    return {
      ...this.tabWhere(f.tab, now),
      ...this.assignedWhere(f.assignedTo),
      lead: { discardedAt: null },
      // Los de los comerciales los lleva cada comercial.
      AND: [
        { OR: [{ assignedToId: null }, { assignedTo: { role: { not: 'sales' } } }] },
        ...(search
          ? [
              {
                OR: [
                  { title: { contains: search, mode: 'insensitive' as const } },
                  { note: { contains: search, mode: 'insensitive' as const } },
                  { lead: { companyName: { contains: search, mode: 'insensitive' as const } } },
                  { lead: { contactName: { contains: search, mode: 'insensitive' as const } } },
                  { lead: { email: { contains: search, mode: 'insensitive' as const } } },
                ],
              },
            ]
          : []),
      ],
    };
  }

  // -------------------------------------------------------------- bandeja

  async inbox(filters: FollowupInboxFilters, now = new Date()): Promise<AdminFollowupInboxDto> {
    const tabs: AdminFollowupTab[] = ['today', 'overdue', 'upcoming', 'done'];
    const withTenants = filters.kind !== 'lead';
    const withLeads = filters.kind !== 'tenant';
    const countsList = await Promise.all(
      tabs.map(async (tab) => {
        const f = { ...filters, tab };
        const [t, l] = await Promise.all([
          withTenants ? this.admin.tenantFollowup.count({ where: this.tenantWhere(f, now) }) : 0,
          withLeads ? this.admin.platformLeadFollowup.count({ where: this.leadWhere(f, now) }) : 0,
        ]);
        return [tab, t + l] as const;
      }),
    );
    const counts = Object.fromEntries(countsList) as Record<AdminFollowupTab, number>;
    const done = filters.tab === 'done';
    const order = done
      ? [{ completedAt: 'desc' as const }, { id: 'asc' as const }]
      : [{ dueDate: 'asc' as const }, { createdAt: 'asc' as const }];

    const [tenantRows, leadRows] = await Promise.all([
      withTenants
        ? this.admin.tenantFollowup.findMany({
            where: this.tenantWhere(filters, now),
            include: {
              tenant: { select: { name: true, status: true } },
              assignedTo: { select: { fullName: true } },
              superAdmin: { select: { fullName: true } },
            },
            orderBy: order,
            take: INBOX_LIMIT,
          })
        : [],
      withLeads
        ? this.admin.platformLeadFollowup.findMany({
            where: this.leadWhere(filters, now),
            include: {
              lead: {
                select: { companyName: true, contactName: true, email: true, status: true },
              },
              assignedTo: { select: { fullName: true } },
              superAdmin: { select: { fullName: true } },
            },
            orderBy: order,
            take: INBOX_LIMIT,
          })
        : [],
    ]);
    const closers = await this.names([
      ...tenantRows.map((r) => r.completedById),
      ...leadRows.map((r) => r.completedById),
    ]);
    const items: AdminFollowupItemDto[] = [
      ...tenantRows.map(
        (r): AdminFollowupItemDto => ({
          kind: 'tenant',
          id: r.id,
          subjectId: r.tenantId,
          subjectName: r.tenant.name,
          subjectStatus: r.tenant.status,
          title: r.title,
          note: r.note,
          dueDate: dayOf(r.dueDate),
          status: r.status === 'done' ? 'done' : 'pending',
          completedAt: r.completedAt?.toISOString() ?? null,
          completedByName: r.completedById ? (closers.get(r.completedById) ?? null) : null,
          outcome: r.outcome,
          assignedToId: r.assignedToId,
          assignedToName: r.assignedTo?.fullName ?? null,
          authorName: r.superAdmin?.fullName ?? null,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
      ...leadRows.map(
        (r): AdminFollowupItemDto => ({
          kind: 'lead',
          id: r.id,
          subjectId: r.leadId,
          subjectName: platformLeadName(r.lead),
          subjectStatus: r.lead.status,
          title: r.title,
          note: r.note,
          dueDate: dayOf(r.dueDate),
          status: r.status === 'done' ? 'done' : 'pending',
          completedAt: r.completedAt?.toISOString() ?? null,
          completedByName: r.completedById ? (closers.get(r.completedById) ?? null) : null,
          outcome: r.outcome,
          assignedToId: r.assignedToId,
          assignedToName: r.assignedTo?.fullName ?? null,
          authorName: r.superAdmin?.fullName ?? null,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
    ];
    items.sort((a, b) =>
      done
        ? (b.completedAt ?? '').localeCompare(a.completedAt ?? '')
        : a.dueDate.localeCompare(b.dueDate) || a.createdAt.localeCompare(b.createdAt),
    );
    return {
      items: items.slice(0, INBOX_LIMIT),
      counts,
      truncated: counts[filters.tab] > INBOX_LIMIT,
    };
  }

  /** Atrasados (vencidos antes de hoy) asignados a mí o sin asignar: aviso del menú. */
  async overdueCount(superAdminId: string, now = new Date()): Promise<number> {
    const mineOrNobody = { OR: [{ assignedToId: null }, { assignedToId: superAdminId }] };
    const today = asDate(madridToday(now));
    const [t, l] = await Promise.all([
      this.admin.tenantFollowup.count({
        where: {
          status: 'pending',
          dueDate: { lt: today },
          tenant: { deletedAt: null },
          ...mineOrNobody,
        },
      }),
      this.admin.platformLeadFollowup.count({
        where: {
          status: 'pending',
          dueDate: { lt: today },
          lead: { discardedAt: null },
          ...mineOrNobody,
        },
      }),
    ]);
    return t + l;
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const rows = await this.admin.superAdmin.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  // ------------------------------------------------------------ crear y editar

  /** Comprueba quién se encarga: activo y, en los de tenants, no comercial. */
  private async assignee(kind: AdminFollowupKind, id: string | null): Promise<string | null> {
    if (!id) return null;
    const sa = await this.admin.superAdmin.findUnique({
      where: { id },
      select: { isActive: true, role: true },
    });
    if (!sa?.isActive || (kind === 'tenant' && sa.role === 'sales')) {
      throw new BadRequestException({
        code: 'invalid_assignee',
        message:
          kind === 'tenant'
            ? 'Ese super admin no existe, está desactivado o es comercial'
            : 'Ese administrador no existe o está desactivado',
      });
    }
    return id;
  }

  async create(
    input: CreateAdminFollowupInput,
    actor: FollowupActor,
  ): Promise<AdminFollowupItemDto> {
    if (input.dueDate < madridToday()) {
      throw new BadRequestException({
        code: 'date_in_past',
        message: 'La fecha ya ha pasado: elige hoy o un día posterior',
      });
    }
    if (input.kind === 'tenant') {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: input.subjectId },
        select: { deletedAt: true },
      });
      if (!tenant || tenant.deletedAt) {
        throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
      }
      // Sin decir quién: quien lo crea.
      const assignedToId =
        input.assignedToId === undefined ? actor.superAdminId : input.assignedToId;
      await this.assignee('tenant', assignedToId);
      const dto = await this.tenantFollowups.create({
        tenantId: input.subjectId,
        superAdminId: actor.superAdminId,
        input: {
          title: input.title,
          dueDate: input.dueDate,
          assignedToId,
          ...(input.note ? { note: input.note } : {}),
        },
      });
      await this.audit.record({
        superAdminId: actor.superAdminId,
        action: 'admin.tenant.followup_created',
        targetType: 'tenant',
        targetId: input.subjectId,
        targetTenantId: input.subjectId,
        changes: { followupId: dto.id, dueDate: input.dueDate, from: 'inbox' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
      return this.item('tenant', dto.id);
    }
    const lead = await this.admin.platformLead.findUnique({
      where: { id: input.subjectId },
      select: { discardedAt: true, assignedToId: true },
    });
    if (!lead || lead.discardedAt) {
      throw new NotFoundException({ code: 'lead_not_found', message: 'Lead no encontrado' });
    }
    const before = new Date();
    await this.leads.createFollowup(
      input.subjectId,
      {
        title: input.title,
        dueDate: input.dueDate,
        ...(input.note ? { note: input.note } : {}),
        ...(input.assignedToId !== undefined
          ? { assignedToId: input.assignedToId }
          : { assignedToId: lead.assignedToId ?? actor.superAdminId }),
      },
      actor,
    );
    const created = await this.admin.platformLeadFollowup.findFirst({
      where: {
        leadId: input.subjectId,
        superAdminId: actor.superAdminId,
        createdAt: { gte: before },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!created) throw new NotFoundException({ code: 'followup_not_found', message: 'No creado' });
    return this.item('lead', created.id);
  }

  /** Un seguimiento suelto en el formato de la bandeja. */
  async item(kind: AdminFollowupKind, id: string): Promise<AdminFollowupItemDto> {
    if (kind === 'tenant') {
      const r = await this.admin.tenantFollowup.findUnique({
        where: { id },
        include: {
          tenant: { select: { name: true, status: true } },
          assignedTo: { select: { fullName: true } },
          superAdmin: { select: { fullName: true } },
        },
      });
      if (!r) throw this.notFound();
      const names = await this.names([r.completedById]);
      return {
        kind,
        id: r.id,
        subjectId: r.tenantId,
        subjectName: r.tenant.name,
        subjectStatus: r.tenant.status,
        title: r.title,
        note: r.note,
        dueDate: dayOf(r.dueDate),
        status: r.status === 'done' ? 'done' : 'pending',
        completedAt: r.completedAt?.toISOString() ?? null,
        completedByName: r.completedById ? (names.get(r.completedById) ?? null) : null,
        outcome: r.outcome,
        assignedToId: r.assignedToId,
        assignedToName: r.assignedTo?.fullName ?? null,
        authorName: r.superAdmin?.fullName ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    }
    const r = await this.admin.platformLeadFollowup.findUnique({
      where: { id },
      include: {
        lead: { select: { companyName: true, contactName: true, email: true, status: true } },
        assignedTo: { select: { fullName: true } },
        superAdmin: { select: { fullName: true } },
      },
    });
    if (!r) throw this.notFound();
    const names = await this.names([r.completedById]);
    return {
      kind,
      id: r.id,
      subjectId: r.leadId,
      subjectName: platformLeadName(r.lead),
      subjectStatus: r.lead.status,
      title: r.title,
      note: r.note,
      dueDate: dayOf(r.dueDate),
      status: r.status === 'done' ? 'done' : 'pending',
      completedAt: r.completedAt?.toISOString() ?? null,
      completedByName: r.completedById ? (names.get(r.completedById) ?? null) : null,
      outcome: r.outcome,
      assignedToId: r.assignedToId,
      assignedToName: r.assignedTo?.fullName ?? null,
      authorName: r.superAdmin?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private notFound() {
    return new NotFoundException({
      code: 'followup_not_found',
      message: 'Seguimiento no encontrado',
    });
  }

  /**
   * Edita un seguimiento (título, nota, fecha, responsable) o lo marca hecho
   * con «qué pasó», que también queda en la conversación del tenant o en la
   * actividad del lead.
   */
  async update(
    kind: AdminFollowupKind,
    id: string,
    input: UpdateAdminFollowupInput,
    actor: FollowupActor,
  ): Promise<AdminFollowupItemDto> {
    const row =
      kind === 'tenant'
        ? await this.admin.tenantFollowup.findUnique({
            where: { id },
            select: { status: true, title: true, tenantId: true },
          })
        : await this.admin.platformLeadFollowup.findUnique({
            where: { id },
            select: { status: true, title: true, leadId: true },
          });
    if (!row) throw this.notFound();
    const subjectId = 'tenantId' in row ? row.tenantId : row.leadId;
    if (input.assignedToId !== undefined) await this.assignee(kind, input.assignedToId);
    const closing = input.status === 'done' && row.status !== 'done';
    const reopening = input.status === 'pending' && row.status === 'done';
    const outcome = input.outcome?.trim() || null;
    const data = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.note !== undefined ? { note: input.note || null } : {}),
      ...(input.dueDate ? { dueDate: asDate(input.dueDate) } : {}),
      ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      ...(closing
        ? {
            status: 'done',
            completedAt: new Date(),
            completedById: actor.superAdminId,
            outcome,
          }
        : {}),
      ...(reopening
        ? { status: 'pending', completedAt: null, completedById: null, outcome: null }
        : {}),
      // «Qué pasó» de uno ya hecho: se corrige.
      ...(!closing && !reopening && input.outcome !== undefined && row.status === 'done'
        ? { outcome }
        : {}),
    };
    if (kind === 'tenant') {
      await this.admin.tenantFollowup.update({ where: { id }, data });
    } else {
      await this.admin.platformLeadFollowup.update({ where: { id }, data });
    }
    const title = input.title ?? row.title;
    if (closing && outcome) await this.logOutcome(kind, subjectId, title, outcome, actor);
    await this.trace(kind, subjectId, id, Object.keys(input), actor);
    return this.item(kind, id);
  }

  private async logOutcome(
    kind: AdminFollowupKind,
    subjectId: string,
    title: string,
    outcome: string,
    actor: FollowupActor,
  ): Promise<void> {
    const content = `Seguimiento hecho: «${title}».\nQué pasó: ${outcome}`;
    if (kind === 'tenant') {
      await this.interactions.create({
        tenantId: subjectId,
        superAdminId: actor.superAdminId,
        input: { type: 'note', content },
      });
    } else {
      await this.leads.addActivity(subjectId, 'note', content, actor.superAdminId);
    }
  }

  private async trace(
    kind: AdminFollowupKind,
    subjectId: string,
    followupId: string,
    fields: string[],
    actor: FollowupActor,
  ): Promise<void> {
    if (kind === 'tenant') {
      await this.audit.record({
        superAdminId: actor.superAdminId,
        action: 'admin.tenant.followup_updated',
        targetType: 'tenant',
        targetId: subjectId,
        targetTenantId: subjectId,
        changes: { followupId, fields },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
    } else {
      await this.leads.record(actor, 'followup_updated', subjectId, { followupId, fields });
    }
  }

  /** Posponer, reasignar o marcar hechos varios a la vez. */
  async bulk(
    input: BulkAdminFollowupsInput,
    actor: FollowupActor,
  ): Promise<BulkAdminFollowupsResultDto> {
    let updated = 0;
    let skipped = 0;
    for (const it of input.items) {
      const status =
        it.kind === 'tenant'
          ? (
              await this.admin.tenantFollowup.findUnique({
                where: { id: it.id },
                select: { status: true },
              })
            )?.status
          : (
              await this.admin.platformLeadFollowup.findUnique({
                where: { id: it.id },
                select: { status: true },
              })
            )?.status;
      if (!status || status === 'done') {
        skipped += 1;
        continue;
      }
      const change: UpdateAdminFollowupInput =
        input.action === 'postpone'
          ? { dueDate: addDaysToDay(madridToday(), input.days ?? 1) }
          : input.action === 'assign'
            ? { assignedToId: input.assignedToId ?? null }
            : { status: 'done', ...(input.outcome ? { outcome: input.outcome } : {}) };
      try {
        await this.update(it.kind, it.id, change, actor);
        updated += 1;
      } catch (err) {
        // Un responsable que no vale para este tipo (comercial en un tenant).
        if (err instanceof BadRequestException) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    return { updated, skipped };
  }
}
