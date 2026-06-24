import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type CreateMaintenancePlanInput,
  firstOccurrence,
  type MaintenancePlanDto,
  nextOccurrence,
  type RecurrenceSpec,
  scheduleLabel,
  type UpdateMaintenancePlanInput,
} from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { MaintenancePlan, Prisma } from '@storageos/database';

type PlanWithRelations = MaintenancePlan & {
  facility?: { name: string } | null;
  assignedTo?: { fullName: string } | null;
};

const INCLUDE = {
  facility: { select: { name: true } },
  assignedTo: { select: { fullName: true } },
} as const;

function toDateOnly(iso: string | undefined): Date {
  if (iso) return new Date(`${iso}T00:00:00.000Z`);
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function specOf(plan: {
  freq: string;
  interval: number;
  weekdays: number[];
  dayOfMonth: number | null;
}): RecurrenceSpec {
  return {
    freq: plan.freq as RecurrenceSpec['freq'],
    interval: plan.interval,
    weekdays: plan.weekdays,
    dayOfMonth: plan.dayOfMonth,
  };
}

/**
 * Mantenimiento recurrente: plantillas que generan tareas automáticamente según
 * una frecuencia. El cron (`MaintenanceCron`) llama a `generateDue` a diario.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<MaintenancePlanDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.maintenancePlan.findMany({
          orderBy: [{ isActive: 'desc' }, { nextRunDate: 'asc' }],
          include: INCLUDE,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateMaintenancePlanInput;
    meta: RequestMeta;
  }): Promise<MaintenancePlanDto> {
    const { input } = args;
    const startDate = toDateOnly(input.startDate);
    const spec = specOf({
      freq: input.freq,
      interval: input.interval,
      weekdays: input.weekdays,
      dayOfMonth: input.dayOfMonth ?? null,
    });
    const nextRunDate = firstOccurrence(spec, startDate);

    const created = await this.prisma.withTenant(
      (tx) =>
        tx.maintenancePlan.create({
          data: {
            tenantId: args.tenantId,
            title: input.title.trim(),
            description: input.description?.trim() || null,
            type: input.type,
            priority: input.priority,
            facilityId: input.facilityId ?? null,
            assignedToUserId: input.assignedToUserId ?? null,
            freq: input.freq,
            interval: input.interval,
            weekdays: input.weekdays,
            dayOfMonth: input.dayOfMonth ?? null,
            checklistTemplate: input.checklistTemplate as Prisma.InputJsonValue,
            startDate,
            nextRunDate,
          },
          include: INCLUDE,
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'maintenance.plan_created',
      entityType: 'MaintenancePlan',
      entityId: created.id,
      changes: { title: created.title, freq: created.freq },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    planId: string;
    input: UpdateMaintenancePlanInput;
    meta: RequestMeta;
  }): Promise<MaintenancePlanDto> {
    await this.findOrThrow(args.tenantId, args.planId);
    const i = args.input;
    const data: Prisma.MaintenancePlanUncheckedUpdateInput = {};
    if (i.title !== undefined) data.title = i.title.trim();
    if (i.description !== undefined) data.description = i.description?.trim() || null;
    if (i.type !== undefined) data.type = i.type;
    if (i.priority !== undefined) data.priority = i.priority;
    if (i.facilityId !== undefined) data.facilityId = i.facilityId;
    if (i.assignedToUserId !== undefined) data.assignedToUserId = i.assignedToUserId;
    if (i.isActive !== undefined) data.isActive = i.isActive;
    if (i.checklistTemplate !== undefined)
      data.checklistTemplate = i.checklistTemplate as Prisma.InputJsonValue;

    const updated = await this.prisma.withTenant(
      (tx) => tx.maintenancePlan.update({ where: { id: args.planId }, data, include: INCLUDE }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'maintenance.plan_updated',
      entityType: 'MaintenancePlan',
      entityId: args.planId,
      changes: i as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    planId: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.planId);
    await this.prisma.withTenant(
      (tx) => tx.maintenancePlan.delete({ where: { id: args.planId } }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'maintenance.plan_deleted',
      entityType: 'MaintenancePlan',
      entityId: args.planId,
      changes: {},
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /**
   * Cron: genera las tareas de los planes activos cuya próxima ejecución ya
   * venció. Cross-tenant (PrismaAdminService) → opera por tenant con withTenant.
   * Devuelve cuántas tareas creó.
   */
  async generateDue(): Promise<{ generated: number }> {
    const today = toDateOnly(undefined);
    const duePlans = await this.admin.maintenancePlan.findMany({
      where: { isActive: true, nextRunDate: { lte: today } },
      take: 500,
      orderBy: { nextRunDate: 'asc' },
    });

    let generated = 0;
    for (const plan of duePlans) {
      try {
        await this.generateFromPlan(plan.tenantId, plan.id);
        generated += 1;
      } catch (err) {
        this.logger.warn(
          `[maintenance] fallo generando plan ${plan.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (generated > 0) this.logger.log(`[maintenance] ${generated} tarea(s) generada(s)`);
    return { generated };
  }

  /**
   * Genera una tarea para el plan si su `nextRunDate` venció y pone el plan al
   * día (avanza `nextRunDate` hasta el futuro sin acumular tareas atrasadas).
   */
  async generateFromPlan(tenantId: string, planId: string): Promise<boolean> {
    const today = toDateOnly(undefined);
    return this.prisma.withTenant(async (tx) => {
      const plan = await tx.maintenancePlan.findUnique({ where: { id: planId } });
      if (!plan || !plan.isActive) return false;
      if (plan.nextRunDate.getTime() > today.getTime()) return false; // aún no toca

      // Instancia el checklist de la plantilla (cada punto con id + estado).
      const template = (plan.checklistTemplate as { label: string }[] | null) ?? [];
      const checklist = template.map((it) => ({
        id: randomUUID(),
        label: it.label,
        status: 'pending' as const,
        note: null,
      }));

      // Crea la tarea con vencimiento en la fecha que tocaba.
      await tx.task.create({
        data: {
          tenantId,
          type: plan.type,
          priority: plan.priority,
          title: plan.title,
          description: plan.description,
          facilityId: plan.facilityId,
          assignedToUserId: plan.assignedToUserId,
          maintenancePlanId: plan.id,
          checklist: checklist as Prisma.InputJsonValue,
          dueDate: plan.nextRunDate,
        },
      });

      // Avanza nextRunDate hasta el futuro (catch-up sin generar más tareas).
      const spec = specOf(plan);
      let next = nextOccurrence(spec, plan.nextRunDate);
      let guard = 0;
      while (next.getTime() <= today.getTime() && guard < 1000) {
        next = nextOccurrence(spec, next);
        guard += 1;
      }
      await tx.maintenancePlan.update({
        where: { id: plan.id },
        data: { nextRunDate: next, lastGeneratedAt: new Date() },
      });
      return true;
    }, tenantId);
  }

  private async findOrThrow(tenantId: string, planId: string): Promise<MaintenancePlan> {
    const row = await this.prisma.withTenant(
      (tx) => tx.maintenancePlan.findUnique({ where: { id: planId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'maintenance_plan_not_found',
        message: 'Plan no encontrado',
      });
    }
    return row;
  }

  private toDto(p: PlanWithRelations): MaintenancePlanDto {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      type: p.type,
      priority: p.priority,
      facilityId: p.facilityId,
      facilityName: p.facility?.name ?? null,
      assignedToUserId: p.assignedToUserId,
      assignedToName: p.assignedTo?.fullName ?? null,
      freq: p.freq as MaintenancePlanDto['freq'],
      interval: p.interval,
      weekdays: p.weekdays,
      dayOfMonth: p.dayOfMonth,
      checklistTemplate: (p.checklistTemplate as { label: string }[] | null) ?? [],
      startDate: p.startDate.toISOString().slice(0, 10),
      nextRunDate: p.nextRunDate.toISOString().slice(0, 10),
      lastGeneratedAt: p.lastGeneratedAt ? p.lastGeneratedAt.toISOString() : null,
      isActive: p.isActive,
      scheduleLabel: scheduleLabel(specOf(p)),
      createdAt: p.createdAt.toISOString(),
    };
  }
}
