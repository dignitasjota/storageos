import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Task, TaskComment, TaskStatus, TaskType } from '@storageos/database';
import type {
  ChecklistItemDto,
  CreateTaskInput,
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
}

type TaskWithIncludes = Task & {
  facility?: { name: string } | null;
  unit?: { code: string } | null;
  assignedTo?: { fullName: string } | null;
};

const ALLOWED_TRANSITIONS: Record<TaskStatusValue, TaskStatusValue[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: [],
  cancelled: ['open'],
};

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<TaskDto[]> {
    const where: Prisma.TaskWhereInput = { deletedAt: null };
    if (filters.status) where.status = filters.status as TaskStatus;
    if (filters.type) where.type = filters.type as TaskType;
    if (filters.facilityId) where.facilityId = filters.facilityId;
    if (filters.unitId) where.unitId = filters.unitId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.task.findMany({
          where,
          include: {
            facility: { select: { name: true } },
            unit: { select: { code: true } },
            assignedTo: { select: { fullName: true } },
          },
          orderBy: [{ status: 'asc' }, { priority: 'desc' }, { dueDate: 'asc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<TaskDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateTaskInput;
    meta: RequestMeta;
  }): Promise<TaskDto> {
    const data: Prisma.TaskUncheckedCreateInput = {
      tenantId: args.tenantId,
      type: args.input.type,
      priority: args.input.priority,
      title: args.input.title,
      description: args.input.description || null,
      facilityId: args.input.facilityId ?? null,
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
          include: {
            facility: { select: { name: true } },
            unit: { select: { code: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.writeAudit('task.created', args, created.id);
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateTaskInput;
    meta: RequestMeta;
  }): Promise<TaskDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (args.input.type !== undefined) data.type = args.input.type;
    if (args.input.priority !== undefined) data.priority = args.input.priority;
    if (args.input.title !== undefined) data.title = args.input.title;
    if (args.input.description !== undefined) data.description = args.input.description || null;
    if (args.input.facilityId !== undefined) data.facilityId = args.input.facilityId ?? null;
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
          include: {
            facility: { select: { name: true } },
            unit: { select: { code: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.writeAudit('task.updated', args, args.id);
    return this.toDto(updated);
  }

  async transition(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: TransitionTaskInput;
    meta: RequestMeta;
  }): Promise<TaskDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
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
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.task.update({
          where: { id: args.id },
          data,
          include: {
            facility: { select: { name: true } },
            unit: { select: { code: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.writeAudit(`task.${args.input.status}`, args, args.id);
    return this.toDto(updated);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id);
    await this.prisma.withTenant(
      (tx) => tx.task.update({ where: { id: args.id }, data: { deletedAt: new Date() } }),
      args.tenantId,
    );
    await this.writeAudit('task.deleted', args, args.id);
  }

  async listComments(tenantId: string, taskId: string): Promise<TaskCommentDto[]> {
    await this.findOrThrow(tenantId, taskId);
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
  }): Promise<TaskCommentDto> {
    await this.findOrThrow(args.tenantId, args.taskId);
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
  }): Promise<TaskDto> {
    const task = await this.findOrThrow(args.tenantId, args.taskId);
    const items = (task.checklist as ChecklistItemDto[] | null) ?? [];
    const idx = items.findIndex((it) => it.id === args.itemId);
    if (idx === -1) {
      throw new NotFoundException({
        code: 'checklist_item_not_found',
        message: 'Punto no encontrado',
      });
    }
    const next = items.map((it, i) =>
      i === idx ? { ...it, status: args.input.status, note: args.input.note?.trim() || null } : it,
    );
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.task.update({
          where: { id: args.taskId },
          data: { checklist: next as unknown as Prisma.InputJsonValue },
          include: {
            facility: { select: { name: true } },
            unit: { select: { code: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      args.tenantId,
    );
    await this.writeAudit('task.checklist_item_updated', args, args.taskId);
    return this.toDto(updated);
  }

  private async findOrThrow(tenantId: string, id: string): Promise<TaskWithIncludes> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.task.findFirst({
          where: { id, deletedAt: null },
          include: {
            facility: { select: { name: true } },
            unit: { select: { code: true } },
            assignedTo: { select: { fullName: true } },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'task_not_found', message: 'Tarea no encontrada' });
    }
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
