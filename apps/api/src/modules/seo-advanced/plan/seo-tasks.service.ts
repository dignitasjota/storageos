import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_TASK_CSV_MAX,
  SEO_TASK_LIST_MAX,
  SEO_TASK_PRIORITIES,
  SEO_TASK_PRIORITY_LABELS,
  SEO_TASK_STATUSES,
  SEO_TASK_STATUS_LABELS,
  SEO_TASK_TYPES,
  SEO_TASK_TYPE_LABELS,
  isSeoDate,
  normalizeSeoKeyword,
  seoMasterOriginLabel,
  seoReorderColumn,
  type CreateSeoTaskInput,
  type MoveSeoTaskInput,
  type SeoTaskDto,
  type SeoTaskListDto,
  type SeoTaskPriority,
  type SeoTaskStatus,
  type SeoTaskType,
  type UpdateSeoTaskInput,
} from '@storageos/shared';

import { CSV_BOM, csvCell, csvLineCell } from '../../../common/csv';
import { todayInTimezone } from '../../../common/format';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type ProjectRow, type SeoOwner } from '../seo-projects.service';

import { assertPlanLinks, loadPlanSource, personNames, resolveDomainId } from './seo-plan-links';
import { SeoTaskNoticesService } from './seo-task-notices.service';

import type { SeoActor } from '../seo-projects.service';

type Row = Prisma.SeoTaskGetPayload<object>;

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
const today = () => todayInTimezone().toISOString().slice(0, 10);

export interface SeoTaskQuery {
  statuses?: SeoTaskStatus[] | undefined;
  type?: SeoTaskType | undefined;
  /** Id de la persona, o `none` = sin asignar. */
  assignedTo?: string | undefined;
  /** Por fecha (límite o, si no hay, de publicación), para el calendario. */
  from?: string | undefined;
  to?: string | undefined;
  search?: string | undefined;
}

export function parseSeoTaskQuery(q: Record<string, string | undefined>): SeoTaskQuery {
  const statuses = q.status
    ? q.status
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is SeoTaskStatus => (SEO_TASK_STATUSES as readonly string[]).includes(s))
    : undefined;
  return {
    statuses: statuses?.length ? statuses : undefined,
    type: (SEO_TASK_TYPES as readonly string[]).includes(q.type ?? '')
      ? (q.type as SeoTaskType)
      : undefined,
    assignedTo:
      q.assignedTo === 'none' ||
      q.assignedTo === 'me' ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q.assignedTo ?? '')
        ? q.assignedTo
        : undefined,
    from: isSeoDate(q.from) ? q.from : undefined,
    to: isSeoDate(q.to) ? q.to : undefined,
    search: q.search?.trim().slice(0, 200) || undefined,
  };
}

/**
 * Tareas SEO de un proyecto (§8 y §15.2): tablero por estado con su orden,
 * calendario por fecha límite o de publicación, lista y CSV. Con dueño
 * (`tenantId` o `null` = la plataforma), solo las suyas; sin dueño
 * (`undefined`), el super admin leyendo cualquier proyecto.
 */
@Injectable()
export class SeoTasksService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly notices: SeoTaskNoticesService,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }

  private async findRow(projectId: string, id: string): Promise<Row> {
    const row = await this.admin.seoTask.findFirst({ where: { id, projectId } });
    if (!row) throw this.notFound();
    return row;
  }

  private where(projectId: string, q: SeoTaskQuery): Prisma.SeoTaskWhereInput {
    const and: Prisma.SeoTaskWhereInput[] = [{ projectId }];
    if (q.statuses?.length) and.push({ status: { in: q.statuses } });
    if (q.type) and.push({ type: q.type });
    if (q.assignedTo === 'none') {
      and.push({ assignedToUserId: null, assignedToSuperAdminId: null });
    } else if (q.assignedTo) {
      and.push({
        OR: [{ assignedToUserId: q.assignedTo }, { assignedToSuperAdminId: q.assignedTo }],
      });
    }
    if (q.from || q.to) {
      const range = {
        ...(q.from ? { gte: asDate(q.from)! } : {}),
        ...(q.to ? { lte: asDate(q.to)! } : {}),
      };
      and.push({ OR: [{ dueDate: range }, { dueDate: null, publishDate: range }] });
    }
    if (q.search) {
      and.push({
        OR: [
          { title: { contains: q.search, mode: 'insensitive' } },
          { description: { contains: q.search, mode: 'insensitive' } },
          { url: { contains: q.search, mode: 'insensitive' } },
          { keywords: { has: normalizeSeoKeyword(q.search) } },
        ],
      });
    }
    return { AND: and };
  }

  async list(
    owner: SeoOwner | undefined,
    projectId: string,
    q: SeoTaskQuery,
  ): Promise<SeoTaskListDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const rows = await this.admin.seoTask.findMany({
      where: this.where(projectId, q),
      orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: SEO_TASK_LIST_MAX + 1,
    });
    const truncated = rows.length > SEO_TASK_LIST_MAX;
    return {
      items: await this.toDtos(project, rows.slice(0, SEO_TASK_LIST_MAX)),
      today: today(),
      truncated,
    };
  }

  async get(owner: SeoOwner | undefined, projectId: string, id: string): Promise<SeoTaskDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const [dto] = await this.toDtos(project, [await this.findRow(projectId, id)]);
    return dto!;
  }

  // ------------------------------------------------------------- cambios

  private async assertAssignee(project: ProjectRow, id: string): Promise<void> {
    const ok = project.tenantId
      ? await this.admin.user.count({ where: { id, tenantId: project.tenantId, isActive: true } })
      : await this.admin.superAdmin.count({ where: { id, isActive: true } });
    if (!ok) {
      throw new BadRequestException({
        code: 'seo_assignee_invalid',
        message: 'Esa persona no puede llevar esta tarea.',
      });
    }
  }

  private assigneeData(project: ProjectRow, id: string | null) {
    return project.tenantId
      ? { assignedToUserId: id, assignedToSuperAdminId: null }
      : { assignedToUserId: null, assignedToSuperAdminId: id };
  }

  private async nextPosition(projectId: string, status: SeoTaskStatus): Promise<number> {
    const max = await this.admin.seoTask.aggregate({
      where: { projectId, status },
      _max: { position: true },
    });
    return (max._max.position ?? -1) + 1;
  }

  async create(
    owner: SeoOwner,
    projectId: string,
    input: CreateSeoTaskInput,
    actor: SeoActor,
  ): Promise<SeoTaskDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    // Desde una oportunidad, canibalización o hallazgo: lo que falte, de ahí.
    const source = await loadPlanSource(this.admin, projectId, input);
    await assertPlanLinks(this.admin, projectId, {
      opportunityId: input.opportunityId ?? null,
      cannibalizationId: input.cannibalizationId ?? null,
      indexFindingId: input.indexFindingId ?? null,
      changeId: input.changeId ?? null,
    });
    if (input.assignedToId) await this.assertAssignee(project, input.assignedToId);
    const status = input.status ?? 'todo';
    const keywords = input.keywords ?? source?.keywords ?? [];
    const row = await this.admin.seoTask.create({
      data: {
        tenantId: project.tenantId,
        projectId,
        domainId: resolveDomainId(project, input.domainId ?? source?.domainId ?? null),
        title: input.title,
        description: input.description ?? null,
        type: input.type ?? source?.taskType ?? 'other',
        status,
        priority: input.priority ?? 'medium',
        ...this.assigneeData(project, input.assignedToId ?? null),
        dueDate: asDate(input.dueDate),
        publishDate: asDate(input.publishDate),
        url: input.url !== undefined ? input.url || null : (source?.urls[0] ?? null),
        keywords: [...new Set(keywords.map((k) => normalizeSeoKeyword(k)).filter(Boolean))],
        opportunityId: input.opportunityId ?? null,
        cannibalizationId: input.cannibalizationId ?? null,
        indexFindingId: input.indexFindingId ?? null,
        changeId: input.changeId ?? null,
        position: await this.nextPosition(projectId, status),
        completedAt: status === 'done' ? new Date() : null,
        createdByUserId: actor.userId ?? null,
        createdBySuperAdminId: actor.superAdminId ?? null,
      },
    });
    await this.notices.assigned(row, actor.userId ?? actor.superAdminId ?? null);
    return this.get(owner, projectId, row.id);
  }

  async update(
    owner: SeoOwner,
    projectId: string,
    id: string,
    input: UpdateSeoTaskInput,
    actor: SeoActor,
  ): Promise<SeoTaskDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, id);
    await assertPlanLinks(this.admin, projectId, {
      opportunityId: input.opportunityId ?? null,
      cannibalizationId: input.cannibalizationId ?? null,
      indexFindingId: input.indexFindingId ?? null,
      changeId: input.changeId ?? null,
    });
    const data: Prisma.SeoTaskUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description || null;
    if (input.type !== undefined) data.type = input.type;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.dueDate !== undefined) data.dueDate = asDate(input.dueDate);
    if (input.publishDate !== undefined) data.publishDate = asDate(input.publishDate);
    // Con otra fecha, vuelve a avisar si vence (el aviso es por fecha y día).
    if (input.dueDate !== undefined || input.publishDate !== undefined) data.dueNotifiedOn = null;
    if (input.domainId !== undefined) data.domainId = resolveDomainId(project, input.domainId);
    if (input.url !== undefined) data.url = input.url || null;
    if (input.keywords !== undefined) {
      data.keywords = [
        ...new Set(input.keywords.map((k) => normalizeSeoKeyword(k)).filter(Boolean)),
      ];
    }
    if (input.opportunityId !== undefined) data.opportunityId = input.opportunityId;
    if (input.cannibalizationId !== undefined) data.cannibalizationId = input.cannibalizationId;
    if (input.indexFindingId !== undefined) data.indexFindingId = input.indexFindingId;
    if (input.changeId !== undefined) data.changeId = input.changeId;
    let assigned = false;
    if (input.assignedToId !== undefined) {
      const current = row.assignedToUserId ?? row.assignedToSuperAdminId;
      if (input.assignedToId) await this.assertAssignee(project, input.assignedToId);
      Object.assign(data, this.assigneeData(project, input.assignedToId));
      assigned = !!input.assignedToId && input.assignedToId !== current;
    }
    if (input.status !== undefined && input.status !== row.status) {
      data.status = input.status;
      data.position = await this.nextPosition(projectId, input.status);
      data.completedAt = input.status === 'done' ? new Date() : null;
    }
    const updated = await this.admin.$transaction(async (tx) => {
      const saved = await tx.seoTask.update({ where: { id: row.id }, data });
      // La actuación enlazada apunta también a esta tarea.
      if (input.changeId) {
        await tx.seoSiteChange.update({
          where: { id: input.changeId },
          data: { taskId: row.id },
        });
      }
      return saved;
    });
    if (assigned) await this.notices.assigned(updated, actor.userId ?? actor.superAdminId ?? null);
    return this.get(owner, projectId, updated.id);
  }

  /** Mueve una tarea a una columna y a un puesto en ella (el tablero). */
  async move(
    owner: SeoOwner,
    projectId: string,
    id: string,
    input: MoveSeoTaskInput,
    /** Quien la mueve (sin permiso de gestionar, solo si la tiene asignada o la creó). */
    actor?: { userId: string; canManage: boolean },
  ): Promise<SeoTaskDto> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, id);
    if (actor && !actor.canManage) {
      const mine = row.assignedToUserId === actor.userId || row.createdByUserId === actor.userId;
      if (!mine) {
        throw new ForbiddenException({
          code: 'seo_task_not_yours',
          message: 'Solo puedes mover las tareas que tienes asignadas o que has creado.',
        });
      }
    }
    await this.admin.$transaction(async (tx) => {
      // Una columna a la vez: dos movimientos en el mismo proyecto esperan su turno.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}), 6)`;
      const column = await tx.seoTask.findMany({
        where: { projectId, status: input.status },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, position: true },
      });
      const order = seoReorderColumn(
        column.map((c) => c.id),
        row.id,
        input.index,
      );
      const current = new Map(column.map((c) => [c.id, c.position]));
      for (const [position, taskId] of order.entries()) {
        if (taskId === row.id) {
          await tx.seoTask.update({
            where: { id: row.id },
            data: {
              position,
              status: input.status,
              ...(input.status !== row.status
                ? { completedAt: input.status === 'done' ? new Date() : null }
                : {}),
            },
          });
        } else if (current.get(taskId) !== position) {
          await tx.seoTask.update({ where: { id: taskId }, data: { position } });
        }
      }
    });
    return this.get(owner, projectId, row.id);
  }

  async remove(owner: SeoOwner, projectId: string, id: string): Promise<void> {
    await this.projects.resolveProject(owner, projectId);
    const row = await this.findRow(projectId, id);
    await this.admin.seoTask.delete({ where: { id: row.id } });
  }

  // ------------------------------------------------------------------- CSV

  async csv(owner: SeoOwner | undefined, projectId: string, q: SeoTaskQuery): Promise<string> {
    const project = await this.projects.resolveProject(owner, projectId);
    const rows = await this.admin.seoTask.findMany({
      where: this.where(projectId, q),
      orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      take: SEO_TASK_CSV_MAX,
    });
    const dtos = await this.toDtos(project, rows);
    const header = [
      'Título',
      'Tipo',
      'Estado',
      'Prioridad',
      'Responsable',
      'Fecha límite',
      'Publicación',
      'Dominio',
      'URL',
      'Palabras',
      'Viene de',
      'Actuación registrada',
      'Descripción',
      'Creada',
      'Hecha',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const t of dtos) {
      lines.push(
        [
          csvLineCell(t.title),
          csvCell(SEO_TASK_TYPE_LABELS[t.type] ?? t.type),
          csvCell(SEO_TASK_STATUS_LABELS[t.status] ?? t.status),
          csvCell(SEO_TASK_PRIORITY_LABELS[t.priority] ?? t.priority),
          csvCell(t.assignedToName),
          csvCell(t.dueDate),
          csvCell(t.publishDate),
          csvCell(t.domain),
          csvCell(t.url),
          csvCell(t.keywords.join(', ')),
          csvLineCell(t.sourceLabel),
          csvLineCell(t.changeTitle),
          csvLineCell(t.description),
          csvCell(t.createdAt.slice(0, 10)),
          csvCell(t.completedAt?.slice(0, 10) ?? null),
        ].join(';'),
      );
    }
    return CSV_BOM + lines.join('\r\n');
  }

  // ---------------------------------------------------------------- DTO

  private async toDtos(project: ProjectRow, rows: Row[]): Promise<SeoTaskDto[]> {
    if (rows.length === 0) return [];
    const ids = (pick: (r: Row) => string | null) => [
      ...new Set(rows.flatMap((r) => (pick(r) ? [pick(r)!] : []))),
    ];
    const [names, opps, cannibs, findings, changes, masters] = await Promise.all([
      personNames(
        this.admin,
        rows.flatMap((r) => [r.assignedToUserId, r.createdByUserId]),
        rows.flatMap((r) => [r.assignedToSuperAdminId, r.createdBySuperAdminId]),
      ),
      this.admin.seoOpportunity.findMany({
        where: { id: { in: ids((r) => r.opportunityId) }, projectId: project.id },
        select: { id: true, query: true },
      }),
      this.admin.seoCannibalization.findMany({
        where: { id: { in: ids((r) => r.cannibalizationId) }, projectId: project.id },
        select: { id: true, query: true },
      }),
      this.admin.seoIndexFinding.findMany({
        where: { id: { in: ids((r) => r.indexFindingId) }, projectId: project.id },
        select: { id: true, url: true },
      }),
      this.admin.seoSiteChange.findMany({
        where: { id: { in: ids((r) => r.changeId) }, projectId: project.id },
        select: { id: true, title: true },
      }),
      this.admin.seoMasterImport.findMany({
        where: { id: { in: ids((r) => r.masterImportId) } },
        select: { id: true, createdAt: true },
      }),
    ]);
    const master = new Map(masters.map((m) => [m.id, m.createdAt.toISOString()]));
    const opp = new Map(opps.map((o) => [o.id, o.query]));
    const can = new Map(cannibs.map((c) => [c.id, c.query]));
    const fin = new Map(findings.map((f) => [f.id, f.url]));
    const chg = new Map(changes.map((c) => [c.id, c.title]));
    const domainName = new Map(project.domains.map((d) => [d.id, d.domain]));
    return rows.map((r) => {
      const assignedToId = r.assignedToUserId ?? r.assignedToSuperAdminId ?? null;
      const sourceLabel = r.opportunityId
        ? `Oportunidad «${opp.get(r.opportunityId) ?? '…'}»`
        : r.cannibalizationId
          ? `Canibalización «${can.get(r.cannibalizationId) ?? '…'}»`
          : r.indexFindingId
            ? `Página en Google «${fin.get(r.indexFindingId) ?? '…'}»`
            : r.masterImportId && master.has(r.masterImportId)
              ? `${seoMasterOriginLabel(master.get(r.masterImportId)!)}${r.externalRef ? ` (${r.externalRef})` : ''}`
              : null;
      return {
        id: r.id,
        projectId: r.projectId,
        title: r.title,
        description: r.description,
        type: r.type as SeoTaskType,
        status: r.status as SeoTaskStatus,
        priority: (SEO_TASK_PRIORITIES as readonly string[]).includes(r.priority)
          ? (r.priority as SeoTaskPriority)
          : 'medium',
        assignedToId,
        assignedToName: assignedToId ? (names.get(assignedToId) ?? null) : null,
        dueDate: dateOnly(r.dueDate),
        publishDate: dateOnly(r.publishDate),
        domainId: r.domainId,
        domain: r.domainId ? (domainName.get(r.domainId) ?? null) : null,
        url: r.url,
        keywords: r.keywords,
        opportunityId: r.opportunityId,
        cannibalizationId: r.cannibalizationId,
        indexFindingId: r.indexFindingId,
        changeId: r.changeId,
        changeTitle: r.changeId ? (chg.get(r.changeId) ?? null) : null,
        sourceLabel,
        position: r.position,
        createdByName:
          names.get(r.createdByUserId ?? '') ?? names.get(r.createdBySuperAdminId ?? '') ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }
}
