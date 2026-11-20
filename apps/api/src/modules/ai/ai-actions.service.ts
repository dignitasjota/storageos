import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TaskPriorityEnum } from '@storageos/shared';
import { z } from 'zod';

import { customerScopeWhere } from '../../common/customer-scope';
import { AuditService } from '../auth/audit.service';
import { InvoicesService } from '../billing/invoices.service';
import { CustomerMessagesService } from '../customer-messages/customer-messages.service';
import { PrismaService } from '../database/prisma.service';
import { TasksService } from '../operations/tasks.service';

import type { RequestMeta } from '../auth/auth.service';
import type { AiActionType, AiPendingActionDto, Permission } from '@storageos/shared';

/** Permiso necesario para PROPONER y para CONFIRMAR cada acción (el del endpoint equivalente). */
export const ACTION_PERMISSIONS: Record<AiActionType, Permission> = {
  create_task: 'tasks:write',
  payment_reminder: 'communications:send',
  customer_message: 'customers:write',
};

/** Fecha AAAA-MM-DD que existe (antes «2026-13-45» pasaba y fallaba al confirmar). */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Fecha no válida');

/** Una acción «en curso» más tiempo que esto se cortó a medias. */
const EXECUTING_STALE_MS = 10 * 60_000;
const CreateTaskPayload = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  dueDate: dateOnly.optional(),
  priority: TaskPriorityEnum.optional(),
  facilityId: z.string().uuid().optional(),
});
const PaymentReminderPayload = z.object({ invoiceNumber: z.string().trim().min(1).max(60) });
const CustomerMessagePayload = z.object({
  customerId: z.string().uuid(),
  body: z.string().trim().min(1).max(2000),
});

export interface AiActionContext {
  tenantId: string;
  userId: string;
  conversationId: string;
  facilityScope: string[] | null;
}

type Proposal = { ok: true; actionId: string; summary: string } | { ok: false; error: string };

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Acciones que el asistente IA propone y el usuario confirma. El modelo solo
 * PROPONE: se valida la entrada y el alcance y se guarda como `proposed`. La
 * ejecución ocurre al confirmar, con los permisos actuales del usuario y los
 * servicios de siempre (misma validación y auditoría que desde el panel).
 */
@Injectable()
export class AiActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly invoices: InvoicesService,
    private readonly customerMessages: CustomerMessagesService,
    private readonly audit: AuditService,
  ) {}

  async propose(ctx: AiActionContext, type: AiActionType, input: unknown): Promise<Proposal> {
    const prepared = await this.prepare(ctx, type, input);
    if (!prepared.ok) return prepared;
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.aiPendingAction.create({
          data: {
            tenantId: ctx.tenantId,
            conversationId: ctx.conversationId,
            userId: ctx.userId,
            type,
            payload: prepared.payload,
            summary: prepared.summary,
          },
        }),
      ctx.tenantId,
    );
    return { ok: true, actionId: row.id, summary: prepared.summary };
  }

  /** Valida la entrada del modelo y resuelve lo que hace falta mostrar/ejecutar. */
  private async prepare(
    ctx: AiActionContext,
    type: AiActionType,
    input: unknown,
  ): Promise<
    { ok: true; payload: Record<string, string>; summary: string } | { ok: false; error: string }
  > {
    if (type === 'create_task') {
      const parsed = CreateTaskPayload.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Datos de la tarea no válidos' };
      const t = parsed.data;
      if (t.facilityId && ctx.facilityScope && !ctx.facilityScope.includes(t.facilityId)) {
        return { ok: false, error: 'Ese local no está entre los tuyos' };
      }
      const payload: Record<string, string> = { title: t.title };
      if (t.description) payload.description = t.description;
      if (t.dueDate) payload.dueDate = t.dueDate;
      if (t.priority) payload.priority = t.priority;
      if (t.facilityId) payload.facilityId = t.facilityId;
      return {
        ok: true,
        payload,
        summary: `Crear la tarea «${t.title}»${t.dueDate ? ` para el ${t.dueDate}` : ''}`,
      };
    }

    if (type === 'payment_reminder') {
      const parsed = PaymentReminderPayload.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Falta el número de factura' };
      const invoice = await this.prisma.withTenant(
        (tx) =>
          tx.invoice.findFirst({
            where: {
              tenantId: ctx.tenantId,
              invoiceNumber: parsed.data.invoiceNumber,
              deletedAt: null,
            },
            select: {
              id: true,
              invoiceNumber: true,
              status: true,
              total: true,
              amountPaid: true,
              customer: {
                select: {
                  customerType: true,
                  firstName: true,
                  lastName: true,
                  companyName: true,
                  email: true,
                },
              },
              contract: { select: { unit: { select: { facilityId: true } } } },
            },
          }),
        ctx.tenantId,
      );
      const facilityId = invoice?.contract?.unit?.facilityId;
      if (
        !invoice ||
        (facilityId && ctx.facilityScope && !ctx.facilityScope.includes(facilityId))
      ) {
        return { ok: false, error: 'Factura no encontrada' };
      }
      if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
        return { ok: false, error: 'La factura no está pendiente de pago' };
      }
      if (!invoice.customer?.email) {
        return { ok: false, error: 'El cliente no tiene email' };
      }
      const pending = Math.max(0, Number(invoice.total) - Number(invoice.amountPaid));
      return {
        ok: true,
        payload: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
        summary: `Enviar recordatorio de pago de la factura ${invoice.invoiceNumber} a ${customerName(
          invoice.customer,
        )} (${pending.toFixed(2)} € pendientes)`,
      };
    }

    const parsed = CustomerMessagePayload.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'Faltan el cliente o el mensaje' };
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: {
            id: parsed.data.customerId,
            tenantId: ctx.tenantId,
            deletedAt: null,
            // Solo a los inquilinos que esta persona puede abrir en el panel.
            ...customerScopeWhere(ctx.facilityScope),
          },
          select: { customerType: true, firstName: true, lastName: true, companyName: true },
        }),
      ctx.tenantId,
    );
    if (!customer) return { ok: false, error: 'Cliente no encontrado' };
    const preview =
      parsed.data.body.length > 120 ? `${parsed.data.body.slice(0, 119)}…` : parsed.data.body;
    return {
      ok: true,
      payload: { customerId: parsed.data.customerId, body: parsed.data.body },
      summary: `Escribir a ${customerName(customer)} por el chat del portal: «${preview}»`,
    };
  }

  /** Enlaza las acciones propuestas en una vuelta con el mensaje del asistente que las acompaña. */
  async attachToMessage(tenantId: string, actionIds: string[], messageId: string): Promise<void> {
    if (actionIds.length === 0) return;
    await this.prisma.withTenant(
      (tx) =>
        tx.aiPendingAction.updateMany({ where: { id: { in: actionIds } }, data: { messageId } }),
      tenantId,
    );
  }

  async listByMessage(
    tenantId: string,
    conversationId: string,
  ): Promise<Map<string, AiPendingActionDto[]>> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.aiPendingAction.findMany({
          where: { conversationId, messageId: { not: null } },
          orderBy: { createdAt: 'asc' },
        }),
      tenantId,
    );
    const map = new Map<string, AiPendingActionDto[]>();
    for (const r of rows) {
      const list = map.get(r.messageId!) ?? [];
      list.push(this.toDto(r));
      map.set(r.messageId!, list);
    }
    return map;
  }

  async confirm(args: {
    tenantId: string;
    userId: string;
    permissions: readonly Permission[];
    facilityScope: string[] | null;
    actionId: string;
    meta: RequestMeta;
  }): Promise<AiPendingActionDto> {
    const action = await this.findOwned(args.tenantId, args.userId, args.actionId);
    const type = action.type as AiActionType;
    // Permisos ACTUALES del usuario (pudieron cambiar desde la propuesta).
    if (!args.permissions.includes(ACTION_PERMISSIONS[type])) {
      throw new ForbiddenException({
        code: 'insufficient_permission',
        message: 'No tienes permiso para esta acción',
      });
    }
    // Reserva atómica: un doble clic no ejecuta dos veces. Queda «en curso»
    // hasta saber el resultado (antes se marcaba hecha antes de hacerla). Una
    // que falló se puede reintentar.
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.aiPendingAction.updateMany({
          where: { id: action.id, status: { in: ['proposed', 'failed'] } },
          data: { status: 'executing', resolvedAt: new Date() },
        }),
      args.tenantId,
    );
    if (claimed.count === 0)
      return this.toDto(await this.findOwned(args.tenantId, args.userId, action.id));

    let result: { link: string } | { error: string };
    try {
      result = await this.execute(args, type, action.payload as Record<string, string>);
    } catch (err) {
      result = {
        error:
          err instanceof Error && 'response' in err
            ? String((err as { response?: { message?: string } }).response?.message ?? err.message)
            : 'No se pudo completar la acción',
      };
    }
    const error = 'error' in result ? result.error : null;
    const failed = error !== null;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.aiPendingAction.update({
          where: { id: action.id },
          data: { status: failed ? 'failed' : 'confirmed', result },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: failed ? 'ai.action_failed' : 'ai.action_confirmed',
      entityType: 'AiPendingAction',
      entityId: action.id,
      changes: { type, summary: action.summary, ...(error ? { error } : {}) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  private async execute(
    args: { tenantId: string; userId: string; facilityScope: string[] | null; meta: RequestMeta },
    type: AiActionType,
    payload: Record<string, string>,
  ): Promise<{ link: string } | { error: string }> {
    if (type === 'create_task') {
      await this.tasks.create({
        tenantId: args.tenantId,
        userId: args.userId,
        input: {
          type: 'other',
          priority: (payload.priority as z.infer<typeof TaskPriorityEnum>) ?? 'normal',
          title: payload.title!,
          ...(payload.description ? { description: payload.description } : {}),
          ...(payload.dueDate ? { dueDate: payload.dueDate } : {}),
          ...(payload.facilityId ? { facilityId: payload.facilityId } : {}),
          metadata: { source: 'ai_assistant' },
        },
        facilityScope: args.facilityScope,
        meta: args.meta,
      });
      return { link: '/tasks' };
    }
    if (type === 'payment_reminder') {
      const res = await this.invoices.bulkRemind({
        tenantId: args.tenantId,
        ids: [payload.invoiceId!],
        facilityScope: args.facilityScope,
      });
      const fail = res.failed[0];
      return fail ? { error: fail.error } : { link: `/invoices/${payload.invoiceId}` };
    }
    // El alcance pudo cambiar desde la propuesta: se vuelve a comprobar.
    const visible = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: {
            id: payload.customerId!,
            deletedAt: null,
            ...customerScopeWhere(args.facilityScope),
          },
          select: { id: true },
        }),
      args.tenantId,
    );
    if (!visible) return { error: 'Ese inquilino no está entre los que puedes ver' };
    await this.customerMessages.sendFromStaff(
      args.tenantId,
      payload.customerId!,
      args.userId,
      payload.body!,
    );
    return { link: `/customers/${payload.customerId}` };
  }

  async discard(tenantId: string, userId: string, actionId: string): Promise<AiPendingActionDto> {
    const action = await this.findOwned(tenantId, userId, actionId);
    await this.prisma.withTenant(
      (tx) =>
        tx.aiPendingAction.updateMany({
          where: { id: action.id, status: { in: ['proposed', 'failed'] } },
          data: { status: 'discarded', resolvedAt: new Date() },
        }),
      tenantId,
    );
    return this.toDto(await this.findOwned(tenantId, userId, action.id));
  }

  private async findOwned(tenantId: string, userId: string, actionId: string) {
    const row = await this.prisma.withTenant(
      (tx) => tx.aiPendingAction.findFirst({ where: { id: actionId, userId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'ai_action_not_found', message: 'Acción no encontrada' });
    }
    return row;
  }

  private toDto(r: {
    id: string;
    type: string;
    summary: string;
    status: string;
    payload: unknown;
    result: unknown;
    resolvedAt?: Date | null;
    createdAt: Date;
  }): AiPendingActionDto {
    const result = (r.result ?? {}) as { link?: string; error?: string };
    // Se cortó a medias: no se sabe si se hizo.
    if (
      r.status === 'executing' &&
      (!r.resolvedAt || Date.now() - r.resolvedAt.getTime() > EXECUTING_STALE_MS)
    ) {
      return {
        id: r.id,
        type: r.type as AiActionType,
        summary: r.summary,
        details: actionDetails(
          r.type,
          (r.payload ?? {}) as { body?: string; description?: string },
        ),
        status: 'failed',
        resultLink: null,
        resultError: 'No se sabe si se completó: compruébalo antes de repetirla.',
        createdAt: r.createdAt.toISOString(),
      };
    }
    const payload = (r.payload ?? {}) as { body?: string; description?: string };
    return {
      id: r.id,
      type: r.type as AiActionType,
      summary: r.summary,
      // Lo que se enviará o guardará, entero, para leerlo antes de confirmar.
      details: actionDetails(r.type, payload),
      status: r.status as AiPendingActionDto['status'],
      resultLink: result.link ?? null,
      resultError: result.error ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

function actionDetails(
  type: string,
  payload: { body?: string; description?: string },
): string | null {
  if (type === 'customer_message') return payload.body ?? null;
  if (type === 'create_task') return payload.description ?? null;
  return null;
}
