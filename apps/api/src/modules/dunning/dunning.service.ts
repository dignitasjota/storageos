import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Job, Queue } from 'bullmq';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import {
  JOB_DUNNING_EXECUTE_ACTION,
  JOB_DUNNING_PROCESS_INVOICE,
  QUEUE_DUNNING,
} from '../queues/queues.module';

import type { DunningActionType } from '@storageos/database';

interface ProcessInvoiceJobData {
  tenantId: string;
  invoiceId: string;
  /** Días vencidos al momento del enqueue (para idempotencia). */
  daysOverdue: number;
}

interface ExecuteActionJobData {
  tenantId: string;
  actionId: string;
}

/**
 * Gestion de impagos. Estrategia:
 *
 * 1. **Cron diario** (`@Cron`) marca como `overdue` las invoices con
 *    `due_date < now()` que sigan en `issued`.
 * 2. Encola un job `process-invoice` por cada factura recien overdue.
 * 3. El worker, segun los dias vencidos, programa una o varias
 *    `dunning_actions` en BD (`status = scheduled`, `scheduledFor`).
 *    Calendario por defecto:
 *      - dia +1: email_reminder (cordial)
 *      - dia +7: email_reminder (con recargo)
 *      - dia +14: access_block (bloqueo de acceso al trastero;
 *                 sincroniza con Fase 5)
 *      - dia +30: legal_notice (escalado manual al admin)
 * 4. Un segundo cron diario corre `execute-due` que despacha las
 *    acciones cuyo `scheduledFor <= now()` enviando emails/SMS o
 *    activando los flags correspondientes.
 */
@Injectable()
@Processor(QUEUE_DUNNING)
export class DunningService extends WorkerHost {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    @InjectQueue(QUEUE_DUNNING) private readonly queue: Queue,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  /**
   * Cron diario 06:00 UTC. Marca overdue + encola process-invoice por
   * cada factura recien vencida + ejecuta acciones pendientes.
   */
  @Cron('0 6 * * *', { name: 'dunning.daily' })
  async dailyTick(): Promise<void> {
    const justOverdue = await this.admin.invoice.findMany({
      where: {
        status: 'issued',
        dueDate: { lt: new Date() },
      },
      select: { id: true, tenantId: true, dueDate: true },
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
      }
      this.logger.log(`Marcadas ${justOverdue.length} facturas como overdue`);
    }
    // Despachar acciones programadas.
    await this.dispatchDueActions();
  }

  async process(job: Job<ProcessInvoiceJobData | ExecuteActionJobData>): Promise<{ ok: boolean }> {
    if (job.name === JOB_DUNNING_PROCESS_INVOICE) {
      const data = job.data as ProcessInvoiceJobData;
      await this.scheduleActions(data);
      return { ok: true };
    }
    if (job.name === JOB_DUNNING_EXECUTE_ACTION) {
      const data = job.data as ExecuteActionJobData;
      await this.executeAction(data);
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
      select: { status: true, customerId: true, invoiceNumber: true },
    });
    if (!invoice || invoice.status === 'paid' || invoice.status === 'cancelled') {
      await this.admin.dunningAction.update({
        where: { id: action.id },
        data: { status: 'cancelled', executedAt: new Date() },
      });
      return;
    }

    // En Fase 4 los efectos colaterales son:
    //   - email_reminder: encolar email (cola `email.send`).
    //   - access_block: setear flag en `dunning_actions.result` para que
    //     Fase 5 (control de accesos) lo lea y desactive credenciales.
    //   - legal_notice: alerta al admin via audit; sin efecto automatico.
    // El envio real de emails se conectara cuando integremos templates
    // de dunning (TODO Fase 4/5).
    await this.admin.dunningAction.update({
      where: { id: action.id },
      data: {
        status: 'executed',
        executedAt: new Date(),
        result: { simulated: true, action: action.actionType },
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

  private daysBetween(a: Date, b: Date): number {
    const ms = b.getTime() - a.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }
}
