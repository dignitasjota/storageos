import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';

import { AccessIntegrationsService } from '../access/access-integrations.service';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { InvoicesService } from '../billing/invoices.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import {
  JOB_DUNNING_EXECUTE_ACTION,
  JOB_DUNNING_PROCESS_INVOICE,
  QUEUE_DUNNING,
} from '../queues/queues.module';

import type { CustomerType, DunningActionType, Prisma } from '@storageos/database';

export interface ProcessInvoiceJobData {
  tenantId: string;
  invoiceId: string;
  /** Días vencidos al momento del enqueue (para idempotencia). */
  daysOverdue: number;
}

export interface ExecuteActionJobData {
  tenantId: string;
  actionId: string;
}

/**
 * Gestion de impagos. Estrategia:
 *
 * 1. **Cron diario** marca como `overdue` las invoices con
 *    `due_date < now()` que sigan en `issued` (lo dispara `DunningCron`).
 * 2. Encola un job `process-invoice` por cada factura recien overdue.
 * 3. El worker, segun los dias vencidos, programa una o varias
 *    `dunning_actions` en BD (`status = scheduled`, `scheduledFor`).
 *    Calendario por defecto:
 *      - dia +1: email_reminder (cordial)
 *      - dia +7: email_reminder (con recargo)
 *      - dia +14: access_block (bloqueo de acceso al trastero;
 *                 sincroniza con Fase 5)
 *      - dia +30: legal_notice (escalado manual al admin)
 * 4. El mismo cron diario despacha las acciones cuyo `scheduledFor <=
 *    now()` enviando emails/SMS o activando los flags correspondientes.
 *
 * NOTA Sub-bloque 14A.1: el `@Cron` y el `@Processor` se han extraido
 * a `DunningProcessor` (en `dunning.processor.ts`) para registrarlos
 * solo cuando `ENABLE_WORKERS_IN_API=true`. Este service queda como
 * logica pura y NO se registra como provider salvo cuando los workers
 * estan activos (porque no se usa desde ningun controller HTTP).
 */
@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    @InjectQueue(QUEUE_DUNNING) private readonly queue: Queue,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
    private readonly events: EventEmitter2,
    private readonly invoices: InvoicesService,
    @Optional() private readonly access: AccessIntegrationsService | null = null,
  ) {}

  /**
   * Marca overdue + encola process-invoice por cada factura recien
   * vencida + ejecuta acciones pendientes. Llamado por `DunningProcessor`
   * desde el cron diario 06:00 UTC.
   */
  async dailyTick(): Promise<void> {
    const justOverdue = await this.admin.invoice.findMany({
      where: {
        status: 'issued',
        dueDate: { lt: new Date() },
      },
      select: {
        id: true,
        tenantId: true,
        dueDate: true,
        customerId: true,
        invoiceNumber: true,
        total: true,
      },
    });
    if (justOverdue.length > 0) {
      await this.admin.invoice.updateMany({
        where: { id: { in: justOverdue.map((i) => i.id) } },
        data: { status: 'overdue' },
      });
      for (const inv of justOverdue) {
        const daysOverdue = this.daysBetween(inv.dueDate!, new Date());
        await this.queue.add(JOB_DUNNING_PROCESS_INVOICE, {
          tenantId: inv.tenantId,
          invoiceId: inv.id,
          daysOverdue,
        } satisfies ProcessInvoiceJobData);
        // Evento de dominio: dispara automations y los webhooks salientes
        // `invoice.overdue` (declarados desde Fase 14 pero sin emisor hasta
        // ahora, igual que le pasaba a invoice_issued).
        const payload: DomainEventPayload = {
          tenantId: inv.tenantId,
          entityType: 'invoice',
          entityId: inv.id,
          customerId: inv.customerId,
          recipientEmail: null,
          scope: {
            invoice: {
              number: inv.invoiceNumber,
              total: Number(inv.total).toFixed(2),
              dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
            },
          },
        };
        this.events.emit(DOMAIN_EVENTS.invoice_overdue, payload);
      }
      this.logger.log(`Marcadas ${justOverdue.length} facturas como overdue`);
    }
    // Despachar acciones programadas.
    await this.dispatchDueActions();
  }

  /** Dispatch del job BullMQ desde `DunningProcessor.process`. */
  async handleJob(
    jobName: string,
    data: ProcessInvoiceJobData | ExecuteActionJobData,
  ): Promise<{ ok: boolean }> {
    if (jobName === JOB_DUNNING_PROCESS_INVOICE) {
      await this.scheduleActions(data as ProcessInvoiceJobData);
      return { ok: true };
    }
    if (jobName === JOB_DUNNING_EXECUTE_ACTION) {
      await this.executeAction(data as ExecuteActionJobData);
      return { ok: true };
    }
    return { ok: false };
  }

  private async scheduleActions(data: ProcessInvoiceJobData): Promise<void> {
    const invoice = await this.admin.invoice.findUnique({
      where: { id: data.invoiceId },
      select: { dueDate: true, status: true },
    });
    if (!invoice || invoice.status === 'paid' || invoice.status === 'cancelled') return;
    if (!invoice.dueDate) return;
    const base = invoice.dueDate;
    const calendar: Array<{ daysAfter: number; type: DunningActionType }> = [
      { daysAfter: 1, type: 'email_reminder' },
      { daysAfter: 7, type: 'email_reminder' },
      { daysAfter: 14, type: 'access_block' },
      { daysAfter: 30, type: 'legal_notice' },
    ];
    // Recargo por mora: solo si el tenant lo activó (opt-in), a los N días.
    const tenant = await this.admin.tenant.findUnique({
      where: { id: data.tenantId },
      select: { lateFeeEnabled: true, lateFeeGraceDays: true },
    });
    if (tenant?.lateFeeEnabled) {
      calendar.push({ daysAfter: tenant.lateFeeGraceDays, type: 'late_fee' });
    }
    for (const step of calendar) {
      const scheduledFor = new Date(base);
      scheduledFor.setUTCDate(scheduledFor.getUTCDate() + step.daysAfter);
      // Si ya existe una accion del mismo tipo para esta invoice, no duplicar.
      const existing = await this.admin.dunningAction.findFirst({
        where: {
          tenantId: data.tenantId,
          invoiceId: data.invoiceId,
          actionType: step.type,
          status: { in: ['scheduled', 'executed'] },
        },
      });
      if (existing) continue;
      await this.admin.dunningAction.create({
        data: {
          tenantId: data.tenantId,
          invoiceId: data.invoiceId,
          actionType: step.type,
          status: 'scheduled',
          scheduledFor,
        },
      });
    }
  }

  private async dispatchDueActions(): Promise<void> {
    const due = await this.admin.dunningAction.findMany({
      where: {
        status: 'scheduled',
        scheduledFor: { lte: new Date() },
      },
      select: { id: true, tenantId: true },
      take: 200,
    });
    for (const action of due) {
      await this.queue.add(JOB_DUNNING_EXECUTE_ACTION, {
        tenantId: action.tenantId,
        actionId: action.id,
      } satisfies ExecuteActionJobData);
    }
  }

  private async executeAction(data: ExecuteActionJobData): Promise<void> {
    const action = await this.admin.dunningAction.findUnique({
      where: { id: data.actionId },
    });
    if (!action || action.status !== 'scheduled') return;
    const invoice = await this.admin.invoice.findUnique({
      where: { id: action.invoiceId },
      select: {
        status: true,
        customerId: true,
        invoiceNumber: true,
        total: true,
        amountPaid: true,
        amountRefunded: true,
        dueDate: true,
        customer: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
          },
        },
      },
    });
    if (!invoice || invoice.status === 'paid' || invoice.status === 'cancelled') {
      await this.admin.dunningAction.update({
        where: { id: action.id },
        data: { status: 'cancelled', executedAt: new Date() },
      });
      return;
    }

    // Fase 8D: efectos colaterales segun action_type:
    //   - email_reminder: encolar email via CommunicationsService (outbox).
    //   - access_block: suspender credenciales del customer via
    //     AccessIntegrationsService.suspendForDunning (Fase 7+8).
    //   - legal_notice: alerta al admin via audit; sin efecto automatico.
    let result: Record<string, string | boolean> = { action: action.actionType };
    try {
      if (action.actionType === 'email_reminder') {
        const sent = await this.sendReminderEmail(action.tenantId, action.invoiceId, invoice);
        result = { ...result, emailEnqueued: sent };
      }
      if (action.actionType === 'access_block' && invoice.customerId && this.access) {
        await this.access.suspendForDunning({
          tenantId: action.tenantId,
          customerId: invoice.customerId,
          invoiceId: action.invoiceId,
        });
        result = { ...result, accessBlocked: true };
      }
      if (action.actionType === 'late_fee') {
        // Re-chequea el opt-in (pudo desactivarse tras agendar). Idempotente:
        // createLateFee lanza si ya existe un recargo para esta factura.
        const tenant = await this.admin.tenant.findUnique({
          where: { id: action.tenantId },
          select: { lateFeeEnabled: true },
        });
        if (tenant?.lateFeeEnabled) {
          const fee = await this.invoices.createLateFee({
            tenantId: action.tenantId,
            invoiceId: action.invoiceId,
            userId: null,
          });
          result = { ...result, lateFeeInvoiceId: fee.id };
        } else {
          result = { ...result, lateFeeSkipped: 'disabled' };
        }
      }
    } catch (err) {
      result = {
        ...result,
        error: err instanceof Error ? err.message : String(err),
      };
      this.logger.warn(
        `dunning.${action.actionType} fallo lateral pero marcamos executed: ${result.error}`,
      );
    }
    await this.admin.dunningAction.update({
      where: { id: action.id },
      data: {
        status: 'executed',
        executedAt: new Date(),
        result,
      },
    });
    await this.audit.write({
      tenantId: action.tenantId,
      action: `dunning.${action.actionType}.executed`,
      entityType: 'DunningAction',
      entityId: action.id,
      changes: { invoiceId: action.invoiceId, invoiceNumber: invoice.invoiceNumber },
    });
    this.logger.log(`Dunning ${action.actionType} ejecutada para invoice ${action.invoiceId}`);
  }

  /**
   * Encola el recordatorio de pago en el outbox de comunicaciones usando la
   * plantilla `invoice_overdue_email` (trigger `invoice_overdue`, que aplica
   * su whitelist de variables). Devuelve `false` sin lanzar cuando no hay
   * customer o email — un impago de una factura simplificada (F2) sin
   * destinatario es valido y no debe romper la ejecucion de la accion.
   */
  private async sendReminderEmail(
    tenantId: string,
    invoiceId: string,
    invoice: {
      invoiceNumber: string;
      total: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
      amountRefunded: Prisma.Decimal;
      dueDate: Date | null;
      customerId: string | null;
      customer: {
        email: string | null;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        customerType: CustomerType;
      } | null;
    },
  ): Promise<boolean> {
    const customer = invoice.customer;
    if (!invoice.customerId || !customer?.email) {
      this.logger.warn(
        `dunning.email_reminder: factura ${invoice.invoiceNumber} sin customer/email; no se envia recordatorio`,
      );
      return false;
    }

    const amountPending =
      Number(invoice.total) - Number(invoice.amountPaid) - Number(invoice.amountRefunded);
    const daysOverdue = invoice.dueDate ? this.daysBetween(invoice.dueDate, new Date()) : 0;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });

    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: customer.email,
      templateCode: 'invoice_overdue_email',
      trigger: 'invoice_overdue',
      variables: {
        customer: {
          firstName: customer.firstName ?? '',
          displayName: this.customerDisplayName(customer),
        },
        invoice: {
          number: invoice.invoiceNumber,
          total: Number(invoice.total).toFixed(2),
          amountPending: amountPending.toFixed(2),
          dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : '',
          daysOverdue,
        },
        tenant: { name: tenant?.name ?? '' },
      },
      customerId: invoice.customerId,
      source: 'dunning.email_reminder',
    });
    this.logger.log(
      `dunning.email_reminder: recordatorio encolado para invoice ${invoiceId} -> ${customer.email}`,
    );
    return true;
  }

  private customerDisplayName(c: {
    customerType: CustomerType;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  }): string {
    if (c.customerType === 'business') return c.companyName ?? 'Empresa sin nombre';
    return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
  }

  private daysBetween(a: Date, b: Date): number {
    const ms = b.getTime() - a.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }
}
