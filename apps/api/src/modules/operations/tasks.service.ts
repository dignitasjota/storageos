import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { assertFacilityAllowed, optionalFacilityWhere } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import {
  addOpsFile,
  asJson,
  opsFileUploadUrl,
  opsFilesDto,
  readOpsFiles,
  removeOpsFile,
} from '../../common/ops-files';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Task, TaskComment, TaskStatus, TaskType } from '@storageos/database';
import type {
  AddOpsFileInput,
  ChecklistItemDto,
  CreateTaskInput,
  MessageAttachmentUploadDto,
  MyTasksCountDto,
  TaskDueFilter,
  TaskCommentDto,
  TaskCommentInput,
  TaskDto,
  TaskStatusValue,
  TaskTypeValue,
  TransitionTaskInput,
  UpdateChecklistItemInput,
  UpdateTaskInput,
} from '@storageos/shared';

interface ListFilters {
  status?: TaskStatusValue;
  type?: TaskTypeValue;
  facilityId?: string;
  assignedToUserId?: string;
  unitId?: string;
  /** Locales del usuario (null = todos). */
  facilityScope?: string[] | null;
  /** Título de la tarea. */
  search?: string;
  /** Vista de pendientes: atrasadas, de hoy, de la semana o sin fecha. */
  due?: TaskDueFilter;
  page?: PageRequest;
}

type TaskWithIncludes = Task & {
  facility?: { name: string } | null;
  unit?: { code: string } | null;
  assignedTo?: { fullName: string } | null;
  maintenancePlan?: { estimatedCost: Prisma.Decimal | null; supplierId: string | null } | null;
};

// Una tarea abierta se puede dar por hecha sin pasar por «En curso»; hecha o
// cancelada se puede reabrir.
const ALLOWED_TRANSITIONS: Record<TaskStatusValue, TaskStatusValue[]> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: ['open'],
  cancelled: ['open'],
};

const TASK_INCLUDE = {
  facility: { select: { name: true } },
  unit: { select: { code: true } },
  assignedTo: { select: { fullName: true } },
  maintenancePlan: { select: { estimatedCost: true, supplierId: true } },
} as const;

const DAY = 86_400_000;
const filePrefix = (tenantId: string, taskId: string) => `${tenantId}/tasks/${taskId}/`;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
  ) {}

  /** Hoy en la zona horaria del negocio (a medianoche UTC). */
  private async today(tenantId: string): Promise<Date> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return todayInTimezone(t?.timezone ?? 'Europe/Madrid');
  }

  private async dueWhere(tenantId: string, due: TaskDueFilter): Promise<Prisma.TaskWhereInput> {
    if (due === 'none') return { dueDate: null, status: { in: ['open', 'in_progress'] } };
    const today = await this.today(tenantId);
    const live = { status: { in: ['open', 'in_progress'] as TaskStatus[] } };
    if (due === 'overdue') return { ...live, dueDate: { lt: today } };
    if (due === 'today') return { ...live, dueDate: today };
    return { ...live, dueDate: { gte: today, lte: new Date(today.getTime() + 7 * DAY) } };
  }

  /** Mis tareas abiertas o en curso, atrasadas o para hoy (el número del menú). */
  async myCount(
    tenantId: string,
    userId: string,
    facilityScope?: string[] | null,
  ): Promise<MyTasksCountDto> {
    const today = await this.today(tenantId);
    const facility = optionalFacilityWhere(facilityScope) ?? {};
    const pending = await this.prisma.withTenant(
      (tx) =>
        tx.task.count({
          where: {
            deletedAt: null,
            assignedToUserId: userId,
            status: { in: ['open', 'in_progress'] },
            dueDate: { lte: today },
            ...facility,
          },
        }),
      tenantId,
    );
    return { pending };
  }

  async photoUploadUrl(
    tenantId: string,
    taskId: string,
    mimeType: string,
    facilityScope?: string[] | null,
  ): Promise<MessageAttachmentUploadDto> {
    await this.findOrThrow(tenantId, taskId, facilityScope);
    return opsFileUploadUrl(this.files, filePrefix(tenantId, taskId), mimeType);
  }

  async addPhoto(
    tenantId: string,
    taskId: string,
    input: AddOpsFileInput,
    facilityScope?: string[] | null,
  ): Promise<TaskDto> {
    const task = await this.findOrThrow(tenantId, taskId, facilityScope);
    const photos = await addOpsFile(
      this.files,
      filePrefix(tenantId, taskId),
      readOpsFiles(task.photos),
      input,
    );
    await this.prisma.withTenant(
      (tx) => tx.task.update({ where: { id: taskId }, data: { photos: asJson(photos) } }),
      tenantId,
    );
    return this.detail(tenantId, taskId, facilityScope);
  }

  async removePhoto(
    tenantId: string,
    taskId: string,
    fileId: string,
    facilityScope?: string[] | null,
  ): Promise<TaskDto> {
    const task = await this.findOrThrow(tenantId, taskId, facilityScope);
    const photos = await removeOpsFile(this.files, readOpsFiles(task.photos), fileId);
    await this.prisma.withTenant(
      (tx) => tx.task.update({ where: { id: taskId }, data: { photos: asJson(photos) } }),
      tenantId,
    );
    return this.detail(tenantId, taskId, facilityScope);
  }

  /** Aviso a quien se le asigna una tarea (no si se la asigna uno mismo). */
  private async notifyAssignee(
    tenantId: string,
    actorId: string | null,
    task: { id: string; title: string; assignedToUserId: string | null; facilityId: string | null },
  ): Promise<void> {
    if (!task.assignedToUserId || task.assignedToUserId === actorId) return;
    await this.notifications
      .create(tenantId, {
        type: 'task.assigned',
        title: 'Te han asignado una tarea',
        body: task.title,
        link: `/tasks?task=${task.id}`,
        facilityId: task.facilityId,
        userId: task.assignedToUserId,
      })
      .catch(() => undefined);
  }

  /** Asignar (o quitar) varias tareas a la vez. */
  async bulkAssign(args: {
    tenantId: string;
    userId: string;
    taskIds: string[];
    assignedToUserId: string | null;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<{ updated: number }> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.task.findMany({
          where: { id: { in: args.taskIds }, deletedAt: null },
          select: { id: true, facilityId: true, title: true },
        }),
      args.tenantId,
    );
    for (const r of rows) if (r.facilityId) assertFacilityAllowed(args.facilityScope, r.facilityId);
    if (args.assignedToUserId) {
      const user = await this.prisma.withTenant(
        (tx) =>
          tx.user.findFirst({
            where: { id: args.assignedToUserId!, isActive: true },
            select: { id: true },
          }),
        args.tenantId,
      );
      if (!user) {
        throw new NotFoundException({ code: 'user_not_found', message: 'Usuario no encontrado' });
      }
    }
    const res = await this.prisma.withTenant(
      (tx) =>
        tx.task.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { assignedToUserId: args.assignedToUserId },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'task.bulk_assigned',
      entityType: 'Task',
      entityId: rows[0]?.id ?? null,
      changes: { taskIds: rows.map((r) => r.id), assignedToUserId: args.assignedToUserId },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    if (args.assignedToUserId && args.assignedToUserId !== args.userId && rows.length > 0) {
      await this.notifications
        .create(args.tenantId, {
          type: 'task.assigned',
          title:
            rows.length === 1
              ? 'Te han asignado una tarea'
              : `Te han asignado ${rows.length} tareas`,
          body:
            rows.length === 1
              ? rows[0]!.title
              : rows
                  .map((r) => r.title)
                  .slice(0, 3)
                  .join(' · '),
          link: '/tasks?mine=1',
          userId: args.assignedToUserId,
        })
        .catch(() => undefined);
    }
    return { updated: res.count };
  }

  /**
   * Comprueba el local, el trastero y el responsable: que existan, que sean de
   * los locales del usuario y que el trastero sea del local elegido. Sin local,
   * toma el del trastero. Devuelve el local que queda.
   */
  private async checkRefs(
    tenantId: string,
    scope: string[] | null | undefined,
    refs: {
      facilityId?: string | null | undefined;
      unitId?: string | null | undefined;
      assignedToUserId?: string | null | undefined;
    },
  ): Promise<{ facilityId: string | null | undefined }> {
    let facilityId = refs.facilityId;
    await this.prisma.withTenant(async (tx) => {
      if (facilityId) {
        assertFacilityAllowed(scope, facilityId);
        const f = await tx.facility.count({ where: { id: facilityId, deletedAt: null } });
        if (f === 0) {
          throw new BadRequestException({
            code: 'facility_not_found',
            message: 'Local no encontrado',
          });
        }
      }
      if (refs.unitId) {
        const unit = await tx.unit.findFirst({
          where: { id: refs.unitId },
          select: { facilityId: true },
        });
        if (!unit) {
          throw new BadRequestException({
            code: 'unit_not_found',
            message: 'Trastero no encontrado',
          });
        }
        assertFacilityAllowed(scope, unit.facilityId);
        if (facilityId && unit.facilityId !== facilityId) {
          throw new BadRequestException({
            code: 'unit_not_in_facility',
            message: 'Ese trastero no es del local elegido',
          });
        }
        if (facilityId === undefined || facilityId === null) facilityId = unit.facilityId;
      }
      if (refs.assignedToUserId) {
        const user = await tx.user.count({
          where: { id: refs.assignedToUserId, isActive: true },
        });
        if (user === 0) {
          throw new BadRequestException({
            code: 'assignee_not_found',
            message: 'La persona elegida no está en el equipo o está desactivada',
          });
        }
      }
    }, tenantId);
    return { facilityId };
  }

  async list(tenantId: string, filters: ListFilters): Promise<TaskDto[]> {
    const where: Prisma.TaskWhereInput = { deletedAt: null };
    if (filters.status) where.status = filters.status as TaskStatus;
    if (filters.type) where.type = filters.type as TaskType;
    const facility = optionalFacilityWhere(filters.facilityScope, filters.facilityId);
    if (!facility) return [];
    Object.assign(where, facility);
    if (filters.unitId) where.unitId = filters.unitId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    if (filters.search) where.title = { contains: filters.search, mode: 'insensitive' };
    if (filters.due) Object.assign(where, await this.dueWhere(tenantId, filters.due));
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.task.findMany({
          where,
          include: TASK_INCLUDE,
          orderBy: [{ status: 'asc' }, { priority: 'desc' }, { dueDate: 'asc' }, { id: 'asc' }],
          ...(filters.page ? pageArgs(filters.page) : { take: 500 }),
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string, facilityScope?: string[] | null): Promise<TaskDto> {
    const row = await this.findOrThrow(tenantId, id, facilityScope);
    // En la ficha, las fotos con su URL firmada.
    return { ...this.toDto(row), photos: await opsFilesDto(this.files, readOpsFiles(row.photos)) };
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateTaskInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<TaskDto> {
    const refs = await this.checkRefs(args.tenantId, args.facilityScope, args.input);
    const data: Prisma.TaskUncheckedCreateInput = {
      tenantId: args.tenantId,
      type: args.input.type,
      priority: args.input.priority,
      title: args.input.title,
      description: args.input.description || null,
      facilityId: refs.facilityId ?? null,
      unitId: args.input.unitId ?? null,
      assignedToUserId: args.input.assignedToUserId ?? null,
      createdByUserId: args.userId,
      dueDate: args.input.dueDate ? new Date(args.input.dueDate) : null,
      metadata: args.input.metadata as Prisma.InputJsonValue,
    };
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.task.create({
          data,
          include: TASK_INCLUDE,
        }),
      args.tenantId,
    );
    await this.writeAudit('task.created', args, created.id);
    await this.notifyAssignee(args.tenantId, args.userId, created);
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateTaskInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<TaskDto> {
    const before = await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    // El trastero se comprueba contra el local que quedará (el nuevo o el que tenía).
    const nextFacility =
      args.input.facilityId !== undefined ? args.input.facilityId : before.facilityId;
    const nextUnit = args.input.unitId !== undefined ? args.input.unitId : before.unitId;
    const refs = await this.checkRefs(args.tenantId, args.facilityScope, {
      facilityId: nextFacility,
      unitId:
        args.input.unitId !== undefined || args.input.facilityId !== undefined ? nextUnit : null,
      assignedToUserId: args.input.assignedToUserId,
    });
    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (args.input.type !== undefined) data.type = args.input.type;
    if (args.input.priority !== undefined) data.priority = args.input.priority;
    if (args.input.title !== undefined) data.title = args.input.title;
    if (args.input.description !== undefined) data.description = args.input.description || null;
    if (args.input.facilityId !== undefined || refs.facilityId !== nextFacility) {
      data.facilityId = refs.facilityId ?? null;
    }
    if (args.input.unitId !== undefined) data.unitId = args.input.unitId ?? null;
    if (args.input.assignedToUserId !== undefined)
      data.assignedToUserId = args.input.assignedToUserId ?? null;
    if (args.input.dueDate !== undefined)
      data.dueDate = args.input.dueDate ? new Date(args.input.dueDate) : null;
    if (args.input.metadata !== undefined)
      data.metadata = args.input.metadata as Prisma.InputJsonValue;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.task.update({
          where: { id: args.id },
          data,
          include: TASK_INCLUDE,
        }),
      args.tenantId,
    );
    await this.writeAudit('task.updated', args, args.id);
    if (updated.assignedToUserId !== before.assignedToUserId) {
      await this.notifyAssignee(args.tenantId, args.userId, updated);
    }
    return this.toDto(updated);
  }

  async transition(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: TransitionTaskInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<TaskDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    const allowed = ALLOWED_TRANSITIONS[existing.status as TaskStatusValue];
    if (!allowed.includes(args.input.status)) {
      throw new ConflictException({
        code: 'invalid_task_transition',
        message: `No se puede pasar de ${existing.status} a ${args.input.status}`,
      });
    }
    const data: Prisma.TaskUncheckedUpdateInput = { status: args.input.status };
    const now = new Date();
    if (args.input.status === 'in_progress' && !existing.startedAt) data.startedAt = now;
    if (args.input.status === 'done') data.completedAt = now;
    if (args.input.status === 'cancelled') {
      data.cancelledAt = now;
      if (args.input.reason) data.cancelReason = args.input.reason;
    }
    if (args.input.status === 'open') {
      // Reabrir: fuera las marcas de cierre.
      data.completedAt = null;
      data.cancelledAt = null;
      data.cancelReason = null;
    }
    const updated = await this.prisma.withTenant(async (tx) => {
      // Dos clics a la vez: solo cambia si sigue en el estado que se leyó.
      const moved = await tx.task.updateMany({
        where: { id: args.id, status: existing.status },
        data,
      });
      if (moved.count === 0) {
        throw new ConflictException({
          code: 'task_changed',
          message: 'La tarea acaba de cambiar: vuelve a abrirla',
        });
      }
      return tx.task.findUniqueOrThrow({
        where: { id: args.id },
        include: TASK_INCLUDE,
      });
    }, args.tenantId);
    await this.writeAudit(
      `task.${args.input.status === 'open' ? 'reopened' : args.input.status}`,
      args,
      args.id,
    );
    return this.toDto(updated);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    await this.prisma.withTenant(
      (tx) => tx.task.update({ where: { id: args.id }, data: { deletedAt: new Date() } }),
      args.tenantId,
    );
    await this.writeAudit('task.deleted', args, args.id);
  }

  async listComments(
    tenantId: string,
    taskId: string,
    facilityScope?: string[] | null,
  ): Promise<TaskCommentDto[]> {
    await this.findOrThrow(tenantId, taskId, facilityScope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.taskComment.findMany({
          where: { taskId, deletedAt: null },
          include: { author: { select: { fullName: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      tenantId,
    );
    return rows.map((c) => this.commentToDto(c));
  }

  async addComment(args: {
    tenantId: string;
    userId: string;
    taskId: string;
    input: TaskCommentInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<TaskCommentDto> {
    await this.findOrThrow(args.tenantId, args.taskId, args.facilityScope);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.taskComment.create({
          data: {
            tenantId: args.tenantId,
            taskId: args.taskId,
            authorUserId: args.userId,
            body: args.input.body,
          },
          include: { author: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    await this.writeAudit('task.comment_added', args, args.taskId);
    return this.commentToDto(created);
  }

  /** Marca un punto del checklist de la tarea (ronda): ok / incidencia + nota. */
  async updateChecklistItem(args: {
    tenantId: string;
    userId: string;
    taskId: string;
    itemId: string;
    input: UpdateChecklistItemInput;
    meta: RequestMeta;
    /** Locales del usuario (null = todos). */
    facilityScope?: string[] | null;
  }): Promise<TaskDto> {
    await this.findOrThrow(args.tenantId, args.taskId, args.facilityScope);
    // La fila se bloquea: dos personas marcando puntos a la vez ya no se pisan.
    const updated = await this.prisma.withTenant(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${args.taskId}::uuid FOR UPDATE`;
      const task = await tx.task.findUniqueOrThrow({
        where: { id: args.taskId },
        select: { checklist: true },
      });
      const items = (task.checklist as ChecklistItemDto[] | null) ?? [];
      const idx = items.findIndex((it) => it.id === args.itemId);
      if (idx === -1) {
        throw new NotFoundException({
          code: 'checklist_item_not_found',
          message: 'Punto no encontrado',
        });
      }
      const next = items.map((it, i) =>
        i === idx
          ? { ...it, status: args.input.status, note: args.input.note?.trim() || null }
          : it,
      );
      return tx.task.update({
        where: { id: args.taskId },
        data: { checklist: next as unknown as Prisma.InputJsonValue },
        include: TASK_INCLUDE,
      });
    }, args.tenantId);
    await this.writeAudit('task.checklist_item_updated', args, args.taskId);
    return this.toDto(updated);
  }

  private async findOrThrow(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<TaskWithIncludes> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.task.findFirst({
          where: { id, deletedAt: null },
          include: TASK_INCLUDE,
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'task_not_found', message: 'Tarea no encontrada' });
    }
    // Alcance por local: lo de un local fuera del suyo no se ve ni se toca
    // (lo de toda la empresa, sin local, sí).
    if (row.facilityId) assertFacilityAllowed(facilityScope, row.facilityId);
    return row as TaskWithIncludes;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'Task',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(t: TaskWithIncludes): TaskDto {
    return {
      id: t.id,
      type: t.type,
      status: t.status,
      priority: t.priority,
      title: t.title,
      description: t.description,
      facilityId: t.facilityId,
      facilityName: t.facility?.name ?? null,
      unitId: t.unitId,
      unitCode: t.unit?.code ?? null,
      assignedToUserId: t.assignedToUserId,
      assignedToName: t.assignedTo?.fullName ?? null,
      createdByUserId: t.createdByUserId,
      maintenancePlanId: t.maintenancePlanId,
      checklist: (t.checklist as ChecklistItemDto[] | null) ?? [],
      photos: readOpsFiles(t.photos).map((f) => ({
        id: f.id,
        filename: f.filename,
        mimeType: f.mimeType,
        createdAt: f.createdAt,
        url: '',
      })),
      expenseId:
        typeof (t.metadata as { expenseId?: unknown } | null)?.expenseId === 'string'
          ? (t.metadata as { expenseId: string }).expenseId
          : null,
      estimatedCost:
        t.maintenancePlan?.estimatedCost != null ? Number(t.maintenancePlan.estimatedCost) : null,
      supplierId: t.maintenancePlan?.supplierId ?? null,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
      startedAt: t.startedAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null,
      cancelledAt: t.cancelledAt?.toISOString() ?? null,
      cancelReason: t.cancelReason,
      metadata: (t.metadata ?? {}) as Record<string, unknown>,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private commentToDto(c: TaskComment & { author?: { fullName: string } | null }): TaskCommentDto {
    return {
      id: c.id,
      taskId: c.taskId,
      authorUserId: c.authorUserId,
      authorName: c.author?.fullName ?? null,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
