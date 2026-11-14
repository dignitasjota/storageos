import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';

import { todayInTimezone } from '../../common/format';
import { BusinessRemindersService } from '../business-reminders/business-reminders.service';
import { CustomerMessagesService } from '../customer-messages/customer-messages.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { ExpensesService } from '../expenses/expenses.service';
import { IncidentsService } from '../operations/incidents.service';
import { TasksService } from '../operations/tasks.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  ExpenseDto,
  IncidentRepairTaskDto,
  OpsExpenseInput,
  OpsTaskInput,
  ReplyIncidentInput,
  TaskDto,
  TaskPriorityValue,
} from '@storageos/shared';

type Scope = string[] | null;

const PRIORITY_BY_SEVERITY: Record<string, TaskPriorityValue> = {
  critical: 'urgent',
  high: 'high',
  medium: 'normal',
  low: 'low',
};

/**
 * Lo que une Operaciones diarias con Gastos, Mensajes y Vencimientos: apuntar
 * el gasto de una tarea o una incidencia, responder al inquilino, crear la
 * tarea de reparación y convertir un vencimiento en tarea. Va aparte porque
 * Gastos depende de la IA, y la IA de Operaciones.
 */
@Injectable()
export class DailyOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly tasks: TasksService,
    private readonly incidents: IncidentsService,
    private readonly expenses: ExpensesService,
    private readonly messages: CustomerMessagesService,
    private readonly reminders: BusinessRemindersService,
  ) {}

  private async today(tenantId: string): Promise<string> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return todayInTimezone(t?.timezone ?? 'Europe/Madrid')
      .toISOString()
      .slice(0, 10);
  }

  /**
   * Reserva el registro para un solo gasto (dos clics a la vez: el segundo
   * recibe 409). Se marca en `metadata` y se suelta si el gasto falla.
   */
  private async claimExpense(
    tenantId: string,
    table: 'tasks' | 'incidents',
    id: string,
  ): Promise<void> {
    const claimed = await this.prisma.withTenant(
      (tx) =>
        table === 'tasks'
          ? tx.$executeRaw`UPDATE tasks SET metadata = metadata || '{"expenseId":"pending"}'::jsonb
              WHERE id = ${id}::uuid AND NOT (metadata ? 'expenseId')`
          : tx.$executeRaw`UPDATE incidents SET metadata = metadata || '{"expenseId":"pending"}'::jsonb
              WHERE id = ${id}::uuid AND expense_id IS NULL AND NOT (metadata ? 'expenseId')`,
      tenantId,
    );
    if (claimed === 0) {
      throw new ConflictException({
        code: 'expense_already_registered',
        message: 'Ya tiene un gasto apuntado',
      });
    }
  }

  private async releaseExpense(tenantId: string, table: 'tasks' | 'incidents', id: string) {
    await this.prisma.withTenant(
      (tx) =>
        table === 'tasks'
          ? tx.$executeRaw`UPDATE tasks SET metadata = metadata - 'expenseId' WHERE id = ${id}::uuid`
          : tx.$executeRaw`UPDATE incidents SET metadata = metadata - 'expenseId' WHERE id = ${id}::uuid`,
      tenantId,
    );
  }

  /** Apunta en Gastos lo que ha costado una tarea (con el proveedor del plan). */
  async taskExpense(
    tenantId: string,
    userId: string,
    taskId: string,
    input: OpsExpenseInput,
    scope: Scope,
  ): Promise<ExpenseDto> {
    const task = await this.tasks.detail(tenantId, taskId, scope);
    await this.claimExpense(tenantId, 'tasks', taskId);
    let expense: ExpenseDto;
    try {
      expense = await this.expenses.create(
        tenantId,
        userId,
        {
          facilityId: task.facilityId,
          category: 'maintenance',
          description: task.title.slice(0, 300),
          amount: input.amount,
          expenseDate: input.expenseDate ?? (await this.today(tenantId)),
          supplierId: input.supplierId ?? task.supplierId ?? null,
          ...(input.vendor ? { vendor: input.vendor } : {}),
        },
        scope,
      );
    } catch (err) {
      await this.releaseExpense(tenantId, 'tasks', taskId);
      throw err;
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.$executeRaw`UPDATE tasks SET metadata = metadata || jsonb_build_object('expenseId', ${expense.id}::text)
          WHERE id = ${taskId}::uuid`,
      tenantId,
    );
    return expense;
  }

  /** Apunta en Gastos la reparación de una incidencia y guarda su coste. */
  async incidentExpense(
    tenantId: string,
    userId: string,
    incidentId: string,
    input: OpsExpenseInput,
    scope: Scope,
  ): Promise<ExpenseDto> {
    const incident = await this.incidents.detail(tenantId, incidentId, scope);
    await this.claimExpense(tenantId, 'incidents', incidentId);
    let expense: ExpenseDto;
    try {
      expense = await this.expenses.create(
        tenantId,
        userId,
        {
          facilityId: incident.facilityId,
          category: 'maintenance',
          description: `Incidencia: ${incident.title}`.slice(0, 300),
          amount: input.amount,
          expenseDate: input.expenseDate ?? (await this.today(tenantId)),
          supplierId: input.supplierId ?? null,
          ...(input.vendor ? { vendor: input.vendor } : {}),
        },
        scope,
      );
    } catch (err) {
      await this.releaseExpense(tenantId, 'incidents', incidentId);
      throw err;
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.incident.update({
          where: { id: incidentId },
          data: {
            expenseId: expense.id,
            cost: input.amount,
            metadata: { ...incident.metadata, expenseId: expense.id } as Prisma.InputJsonValue,
          },
        }),
      tenantId,
    );
    return expense;
  }

  /** Responde al inquilino por su chat del área de clientes y lo deja en la incidencia. */
  async replyToCustomer(
    tenantId: string,
    userId: string,
    incidentId: string,
    input: ReplyIncidentInput,
    meta: RequestMeta,
    scope: Scope,
  ): Promise<void> {
    const incident = await this.incidents.detail(tenantId, incidentId, scope);
    if (!incident.customerId) {
      throw new BadRequestException({
        code: 'incident_without_customer',
        message: 'La incidencia no es de ningún inquilino',
      });
    }
    await this.messages.sendFromStaff(
      tenantId,
      incident.customerId,
      userId,
      `Sobre tu incidencia «${incident.title}»:\n\n${input.body}`,
    );
    await this.incidents.addComment({
      tenantId,
      userId,
      incidentId,
      input: { body: `Respuesta al inquilino: ${input.body}` },
      meta,
      facilityScope: scope,
    });
  }

  /** Tarea de reparación con los datos de la incidencia. */
  async incidentTask(
    tenantId: string,
    userId: string,
    incidentId: string,
    input: OpsTaskInput,
    meta: RequestMeta,
    scope: Scope,
  ): Promise<TaskDto> {
    const incident = await this.incidents.detail(tenantId, incidentId, scope);
    const task = await this.tasks.create({
      tenantId,
      userId,
      input: {
        type: 'maintenance',
        priority: PRIORITY_BY_SEVERITY[incident.severity] ?? 'normal',
        title: input.title ?? `Reparar: ${incident.title}`.slice(0, 200),
        description: incident.description ?? '',
        ...(incident.facilityId ? { facilityId: incident.facilityId } : {}),
        ...(incident.unitId ? { unitId: incident.unitId } : {}),
        ...(input.assignedToUserId
          ? { assignedToUserId: input.assignedToUserId }
          : incident.assignedToUserId
            ? { assignedToUserId: incident.assignedToUserId }
            : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        metadata: { incidentId },
      },
      meta,
      facilityScope: scope,
    });
    await this.incidents.markResponded(tenantId, incidentId);
    return task;
  }

  /** Las tareas creadas desde una incidencia. */
  async incidentTasks(
    tenantId: string,
    incidentId: string,
    scope: Scope,
  ): Promise<IncidentRepairTaskDto[]> {
    await this.incidents.detail(tenantId, incidentId, scope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.task.findMany({
          where: { deletedAt: null, metadata: { path: ['incidentId'], equals: incidentId } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            title: true,
            status: true,
            dueDate: true,
            assignedTo: { select: { fullName: true } },
          },
        }),
      tenantId,
    );
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
      assignedToName: t.assignedTo?.fullName ?? null,
    }));
  }

  /** Un vencimiento como tarea (para quien tiene que hacerlo). Una por fecha. */
  async reminderTask(
    tenantId: string,
    userId: string,
    reminderId: string,
    input: OpsTaskInput,
    meta: RequestMeta,
    scope: Scope,
  ): Promise<TaskDto> {
    const reminder = await this.reminders.get(tenantId, reminderId, scope);
    const already = await this.prisma.withTenant(
      (tx) =>
        tx.task.count({
          where: {
            deletedAt: null,
            status: { in: ['open', 'in_progress'] },
            AND: [
              { metadata: { path: ['reminderId'], equals: reminderId } },
              { metadata: { path: ['reminderDueDate'], equals: reminder.dueDate } },
            ],
          },
        }),
      tenantId,
    );
    if (already > 0) {
      throw new ConflictException({
        code: 'reminder_task_exists',
        message: 'Ya hay una tarea abierta para este vencimiento',
      });
    }
    return this.tasks.create({
      tenantId,
      userId,
      input: {
        type: 'other',
        priority: 'normal',
        title: input.title ?? reminder.title,
        description: '',
        ...(reminder.facilityId ? { facilityId: reminder.facilityId } : {}),
        ...(input.assignedToUserId ? { assignedToUserId: input.assignedToUserId } : {}),
        dueDate: input.dueDate ?? reminder.snoozedUntil ?? reminder.dueDate,
        metadata: { reminderId, reminderDueDate: reminder.dueDate },
      },
      meta,
      facilityScope: scope,
    });
  }
}
