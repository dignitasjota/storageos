import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type CreateMaintenancePlanInput,
  firstOccurrence,
  type MaintenancePlanDto,
  nextOccurrence,
  type RecurrenceSpec,
  scheduleLabel,
  type UpdateMaintenancePlanInput,
  type MaintenanceHistoryDto,
  type MaintenanceHistoryItemDto,
} from '@storageos/shared';

import { assertFacilityAllowed, optionalFacilityWhere } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { RequestMeta } from '../auth/auth.service';
import type { MaintenancePlan, Prisma } from '@storageos/database';

type PlanWithRelations = MaintenancePlan & {
  facility?: { name: string } | null;
  assignedTo?: { fullName: string } | null;
  supplier?: { name: string } | null;
};

const INCLUDE = {
  facility: { select: { name: true } },
  assignedTo: { select: { fullName: true } },
  supplier: { select: { name: true } },
} as const;

const DAY = 86_400_000;

function toDateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const sameDay = (a: Date | null, b: Date) =>
  !!a && a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/** ¿La frecuencia enviada es distinta de la que tiene el plan? */
function scheduleDiffers(current: RecurrenceSpec, next: RecurrenceSpec): boolean {
  const days = (d: number[]) => [...d].sort((a, b) => a - b).join(',');
  return (
    current.freq !== next.freq ||
    current.interval !== next.interval ||
    (next.freq === 'weekly' && days(current.weekdays) !== days(next.weekdays)) ||
    (next.freq === 'monthly' && current.dayOfMonth !== next.dayOfMonth)
  );
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
    private readonly notifications: NotificationsService,
  ) {}

  /** Hoy en la zona horaria del negocio (a medianoche UTC, como las fechas de la base). */
  private async today(tenantId: string): Promise<Date> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return todayInTimezone(t?.timezone ?? 'Europe/Madrid');
  }

  /** El local exista y sea del usuario; el responsable, del equipo y activo. */
  private async checkRefs(
    tenantId: string,
    scope: string[] | null | undefined,
    refs: {
      facilityId?: string | null | undefined;
      assignedToUserId?: string | null | undefined;
      supplierId?: string | null | undefined;
    },
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      if (refs.supplierId) {
        const sup = await tx.expenseSupplier.count({ where: { id: refs.supplierId } });
        if (sup === 0) {
          throw new BadRequestException({
            code: 'supplier_not_found',
            message: 'Proveedor no encontrado',
          });
        }
      }
      if (refs.facilityId) {
        assertFacilityAllowed(scope, refs.facilityId);
        const f = await tx.facility.count({ where: { id: refs.facilityId, deletedAt: null } });
        if (f === 0) {
          throw new BadRequestException({
            code: 'facility_not_found',
            message: 'Local no encontrado',
          });
        }
      }
      if (refs.assignedToUserId) {
        const u = await tx.user.count({ where: { id: refs.assignedToUserId, isActive: true } });
        if (u === 0) {
          throw new BadRequestException({
            code: 'assignee_not_found',
            message: 'La persona elegida no está en el equipo o está desactivada',
          });
        }
      }
    }, tenantId);
  }

  async list(
    tenantId: string,
    filters: { facilityId?: string; facilityScope?: string[] | null } = {},
  ): Promise<MaintenancePlanDto[]> {
    const facility = optionalFacilityWhere(filters.facilityScope, filters.facilityId);
    if (!facility) return [];
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.maintenancePlan.findMany({
          where: facility,
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
    facilityScope?: string[] | null;
  }): Promise<MaintenancePlanDto> {
    const { input } = args;
    await this.checkRefs(args.tenantId, args.facilityScope, input);
    // Empieza hoy como pronto: un inicio pasado no crea tareas ya vencidas.
    const today = await this.today(args.tenantId);
    const asked = input.startDate ? toDateOnly(input.startDate) : today;
    const startDate = asked < today ? today : asked;
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
            leadDays: input.leadDays,
            estimatedCost: input.estimatedCost ?? null,
            supplierId: input.supplierId ?? null,
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
    facilityScope?: string[] | null;
  }): Promise<MaintenancePlanDto> {
    const current = await this.findOrThrow(args.tenantId, args.planId, args.facilityScope);
    const i = args.input;
    await this.checkRefs(args.tenantId, args.facilityScope, i);
    const data: Prisma.MaintenancePlanUncheckedUpdateInput = {};
    const today = await this.today(args.tenantId);
    const currentSpec = specOf(current);
    const spec = specOf({
      freq: i.freq ?? current.freq,
      interval: i.interval ?? current.interval,
      weekdays: i.weekdays ?? current.weekdays,
      dayOfMonth: i.dayOfMonth !== undefined ? i.dayOfMonth : current.dayOfMonth,
    });
    // Solo se recalcula la próxima fecha si cambia la frecuencia o la fecha de
    // inicio (antes, cambiar el título la movía y podía crear una tarea de más).
    const scheduleChanged = scheduleDiffers(currentSpec, spec) || i.startDate !== undefined;
    if (scheduleChanged) {
      if (spec.freq === 'weekly' && spec.weekdays.length === 0) {
        throw new BadRequestException({
          code: 'weekdays_required',
          message: 'Indica al menos un día de la semana',
        });
      }
      if (spec.freq === 'monthly' && !spec.dayOfMonth) {
        throw new BadRequestException({
          code: 'day_of_month_required',
          message: 'Indica el día del mes',
        });
      }
      const asked = i.startDate ? toDateOnly(i.startDate) : today;
      const from = asked < today ? today : asked;
      data.freq = spec.freq;
      data.interval = spec.interval;
      data.weekdays = spec.weekdays;
      data.dayOfMonth = spec.dayOfMonth;
      if (i.startDate) data.startDate = from;
      let next = firstOccurrence(spec, from);
      // La de hoy ya se generó: la siguiente.
      if (sameDay(current.lastGeneratedAt, today) && next.getTime() <= today.getTime()) {
        next = nextOccurrence(spec, today);
      }
      data.nextRunDate = next;
    }
    // Reactivar un plan parado: sigue desde hoy, sin la fecha que se quedó atrás.
    if (
      i.isActive === true &&
      !current.isActive &&
      !scheduleChanged &&
      current.nextRunDate.getTime() < today.getTime()
    ) {
      data.nextRunDate = firstOccurrence(spec, today);
    }
    if (i.title !== undefined) data.title = i.title.trim();
    if (i.description !== undefined) data.description = i.description?.trim() || null;
    if (i.type !== undefined) data.type = i.type;
    if (i.priority !== undefined) data.priority = i.priority;
    if (i.facilityId !== undefined) data.facilityId = i.facilityId;
    if (i.assignedToUserId !== undefined) data.assignedToUserId = i.assignedToUserId;
    if (i.isActive !== undefined) data.isActive = i.isActive;
    if (i.checklistTemplate !== undefined)
      data.checklistTemplate = i.checklistTemplate as Prisma.InputJsonValue;
    if (i.leadDays !== undefined) data.leadDays = i.leadDays;
    if (i.estimatedCost !== undefined) data.estimatedCost = i.estimatedCost;
    if (i.supplierId !== undefined) data.supplierId = i.supplierId;

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
    facilityScope?: string[] | null;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.planId, args.facilityScope);
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
    // Margen de la antelación máxima (60 días) y un día por las zonas horarias:
    // cada plan se compara luego con el día de su negocio.
    const tomorrow = new Date(Date.now() + 61 * DAY);
    const duePlans = await this.admin.maintenancePlan.findMany({
      where: {
        isActive: true,
        nextRunDate: { lte: tomorrow },
        // Los de toda la empresa no tienen local; los de un local borrado no siguen.
        OR: [{ facilityId: null }, { facility: { deletedAt: null } }],
      },
      take: 500,
      orderBy: { nextRunDate: 'asc' },
    });

    let generated = 0;
    for (const plan of duePlans) {
      try {
        if ((await this.generateFromPlan(plan.tenantId, plan.id)).generated) generated += 1;
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
   * Genera la tarea del plan si su fecha ya llegó y pone el plan al día (avanza
   * `nextRunDate` hasta el futuro sin acumular tareas atrasadas). Con `force`
   * («Generar ahora») crea ya la siguiente aunque su fecha esté por llegar.
   */
  async generateFromPlan(
    tenantId: string,
    planId: string,
    facilityScope?: string[] | null,
    opts: { force?: boolean } = {},
  ): Promise<{ generated: boolean; dueDate: string | null; reason?: 'open_task' }> {
    if (facilityScope) await this.findOrThrow(tenantId, planId, facilityScope);
    const today = await this.today(tenantId);
    const result = await this.prisma.withTenant(async (tx) => {
      // Bloqueo: el cron y «Generar ahora» a la vez no crean dos tareas.
      await tx.$queryRaw`SELECT id FROM maintenance_plans WHERE id = ${planId}::uuid FOR UPDATE`;
      const plan = await tx.maintenancePlan.findUnique({ where: { id: planId } });
      if (!plan || !plan.isActive) return null;
      // Con antelación, la tarea sale esos días antes de su fecha.
      if (!opts.force && plan.nextRunDate.getTime() - plan.leadDays * DAY > today.getTime()) {
        return null;
      }
      if (opts.force) {
        // A mano: no se adelanta otra si la anterior sigue sin hacer.
        const open = await tx.task.count({
          where: {
            maintenancePlanId: plan.id,
            deletedAt: null,
            status: { in: ['open', 'in_progress'] },
          },
        });
        if (open > 0) return 'open_task' as const;
      }

      // Instancia el checklist de la plantilla (cada punto con id + estado).
      const template = (plan.checklistTemplate as { label: string }[] | null) ?? [];
      const checklist = template.map((it) => ({
        id: randomUUID(),
        label: it.label,
        status: 'pending' as const,
        note: null,
      }));

      const task = await tx.task.create({
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
        select: { id: true, title: true, assignedToUserId: true, facilityId: true },
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
      return { task, dueDate: plan.nextRunDate.toISOString().slice(0, 10) };
    }, tenantId);
    if (!result) return { generated: false, dueDate: null };
    if (result === 'open_task') return { generated: false, dueDate: null, reason: 'open_task' };
    if (result.task.assignedToUserId) {
      await this.notifications
        .create(tenantId, {
          type: 'task.assigned',
          title: 'Tienes una tarea de mantenimiento',
          body: result.task.title,
          link: `/tasks?task=${result.task.id}`,
          facilityId: result.task.facilityId,
          userId: result.task.assignedToUserId,
        })
        .catch(() => undefined);
    }
    return { generated: true, dueDate: result.dueDate };
  }

  /** Las tareas que ha creado el plan y si se hicieron a tiempo. */
  async history(
    tenantId: string,
    planId: string,
    facilityScope?: string[] | null,
  ): Promise<MaintenanceHistoryDto> {
    await this.findOrThrow(tenantId, planId, facilityScope);
    const today = await this.today(tenantId);
    const tasks = await this.prisma.withTenant(
      (tx) =>
        tx.task.findMany({
          where: { maintenancePlanId: planId, deletedAt: null },
          orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }],
          take: 100,
          select: {
            id: true,
            dueDate: true,
            status: true,
            completedAt: true,
            checklist: true,
            assignedTo: { select: { fullName: true } },
          },
        }),
      tenantId,
    );
    const timezone =
      (
        await this.admin.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true },
        })
      )?.timezone ?? 'Europe/Madrid';
    const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(d);
    const items: MaintenanceHistoryItemDto[] = tasks.map((t) => {
      const due = t.dueDate?.toISOString().slice(0, 10) ?? null;
      const checklist = (t.checklist as { status?: string }[] | null) ?? [];
      return {
        taskId: t.id,
        dueDate: due,
        status: t.status,
        completedAt: t.completedAt?.toISOString() ?? null,
        onTime: t.status === 'done' && t.completedAt && due ? dayOf(t.completedAt) <= due : null,
        assignedToName: t.assignedTo?.fullName ?? null,
        issues: checklist.filter((c) => c.status === 'issue').length,
      };
    });
    const done = items.filter((i) => i.status === 'done');
    return {
      items,
      total: items.length,
      done: done.length,
      onTimePct: done.length
        ? Math.round((done.filter((i) => i.onTime).length / done.length) * 100)
        : null,
      overdueOpen: tasks.filter(
        (t) =>
          (t.status === 'open' || t.status === 'in_progress') &&
          t.dueDate &&
          t.dueDate.getTime() < today.getTime(),
      ).length,
    };
  }

  /** Copia el plan a otros locales (uno por local, con la misma frecuencia). */
  async copyToFacilities(args: {
    tenantId: string;
    userId: string;
    planId: string;
    facilityIds: string[];
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<MaintenancePlanDto[]> {
    const plan = await this.findOrThrow(args.tenantId, args.planId, args.facilityScope);
    const targets = [...new Set(args.facilityIds)].filter((id) => id !== plan.facilityId);
    for (const id of targets)
      await this.checkRefs(args.tenantId, args.facilityScope, { facilityId: id });
    const today = await this.today(args.tenantId);
    const spec = specOf(plan);
    const start = plan.nextRunDate.getTime() < today.getTime() ? today : plan.nextRunDate;
    const created = await this.prisma.withTenant(
      (tx) =>
        Promise.all(
          targets.map((facilityId) =>
            tx.maintenancePlan.create({
              data: {
                tenantId: args.tenantId,
                title: plan.title,
                description: plan.description,
                type: plan.type,
                priority: plan.priority,
                facilityId,
                // El responsable de un local no tiene por qué ser el del otro.
                assignedToUserId: null,
                freq: plan.freq,
                interval: plan.interval,
                weekdays: plan.weekdays,
                dayOfMonth: plan.dayOfMonth,
                checklistTemplate: plan.checklistTemplate as Prisma.InputJsonValue,
                startDate: start,
                nextRunDate: firstOccurrence(spec, start),
                leadDays: plan.leadDays,
                estimatedCost: plan.estimatedCost,
                supplierId: plan.supplierId,
              },
              include: INCLUDE,
            }),
          ),
        ),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'maintenance.plan_copied',
      entityType: 'MaintenancePlan',
      entityId: plan.id,
      changes: { facilityIds: targets },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return created.map((p) => this.toDto(p));
  }

  private async findOrThrow(
    tenantId: string,
    planId: string,
    facilityScope?: string[] | null,
  ): Promise<MaintenancePlan> {
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
    if (row.facilityId) assertFacilityAllowed(facilityScope, row.facilityId);
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
      leadDays: p.leadDays,
      estimatedCost: p.estimatedCost !== null ? Number(p.estimatedCost) : null,
      supplierId: p.supplierId,
      supplierName: p.supplier?.name ?? null,
      scheduleLabel: scheduleLabel(specOf(p)),
      createdAt: p.createdAt.toISOString(),
    };
  }
}
