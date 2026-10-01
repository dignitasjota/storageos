import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';

import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { JOB_AUTOMATIONS_RUN, QUEUE_AUTOMATIONS } from '../queues/queues.module';

import { DOMAIN_EVENTS, type DomainEventPayload } from './domain-events';

import type { RequestMeta } from '../auth/auth.service';
import type { AutomationRule, Prisma } from '@storageos/database';
import type {
  AutomationRuleDto,
  AutomationRunDto,
  AutomationTriggerValue,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '@storageos/shared';

interface AutomationJobData {
  tenantId: string;
  ruleId: string;
  trigger: AutomationTriggerValue;
  entityType: string;
  entityId: string;
  recipientEmail: string | null;
  recipientPhone: string | null;
  customerId: string | null;
  leadId: string | null;
  scope: Record<string, unknown>;
}

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
    @InjectQueue(QUEUE_AUTOMATIONS) private readonly queue: Queue,
  ) {}

  // -----------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------

  async list(tenantId: string): Promise<AutomationRuleDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.automationRule.findMany({
          orderBy: [{ trigger: 'asc' }, { name: 'asc' }],
          include: { template: { select: { name: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateAutomationRuleInput;
    meta: RequestMeta;
  }): Promise<AutomationRuleDto> {
    await this.assertAction(args.tenantId, args.input.actionType, args.input.templateId ?? null);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.automationRule.create({
          data: {
            tenantId: args.tenantId,
            name: args.input.name,
            trigger: args.input.trigger,
            actionType: args.input.actionType,
            templateId: args.input.templateId ?? null,
            conditions: args.input.conditions as Prisma.InputJsonValue,
            delayMinutes: args.input.delayMinutes,
            isActive: args.input.isActive,
          },
          include: { template: { select: { name: true } } },
        }),
      args.tenantId,
    );
    await this.writeAudit('automation_rule.created', args, created.id);
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateAutomationRuleInput;
    meta: RequestMeta;
  }): Promise<AutomationRuleDto> {
    const current = await this.findOrThrow(args.tenantId, args.id);
    if (args.input.actionType !== undefined || args.input.templateId !== undefined) {
      await this.assertAction(
        args.tenantId,
        args.input.actionType ?? current.actionType,
        args.input.templateId !== undefined ? args.input.templateId : current.templateId,
      );
    }
    const data: Prisma.AutomationRuleUncheckedUpdateInput = {};
    if (args.input.name !== undefined) data.name = args.input.name;
    if (args.input.trigger !== undefined) data.trigger = args.input.trigger;
    if (args.input.actionType !== undefined) data.actionType = args.input.actionType;
    if (args.input.templateId !== undefined) data.templateId = args.input.templateId;
    if (args.input.conditions !== undefined)
      data.conditions = args.input.conditions as Prisma.InputJsonValue;
    if (args.input.delayMinutes !== undefined) data.delayMinutes = args.input.delayMinutes;
    if (args.input.isActive !== undefined) data.isActive = args.input.isActive;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.automationRule.update({
          where: { id: args.id },
          data,
          include: { template: { select: { name: true } } },
        }),
      args.tenantId,
    );
    await this.writeAudit('automation_rule.updated', args, args.id);
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
      (tx) => tx.automationRule.delete({ where: { id: args.id } }),
      args.tenantId,
    );
    await this.writeAudit('automation_rule.deleted', args, args.id);
  }

  // -----------------------------------------------------------------
  // Listeners
  // -----------------------------------------------------------------

  @OnEvent(DOMAIN_EVENTS.customer_created, { async: true, promisify: true })
  async onCustomerCreated(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('customer_created', p);
  }
  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('contract_signed', p);
  }
  @OnEvent(DOMAIN_EVENTS.contract_ending_soon, { async: true, promisify: true })
  async onContractEndingSoon(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('contract_ending_soon', p);
  }
  @OnEvent(DOMAIN_EVENTS.contract_ended, { async: true, promisify: true })
  async onContractEnded(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('contract_ended', p);
  }
  @OnEvent(DOMAIN_EVENTS.invoice_issued, { async: true, promisify: true })
  async onInvoiceIssued(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('invoice_issued', p);
  }
  @OnEvent(DOMAIN_EVENTS.invoice_overdue, { async: true, promisify: true })
  async onInvoiceOverdue(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('invoice_overdue', p);
  }
  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('invoice_paid', p);
  }
  @OnEvent(DOMAIN_EVENTS.reservation_confirmed, { async: true, promisify: true })
  async onReservationConfirmed(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('reservation_confirmed', p);
  }
  @OnEvent(DOMAIN_EVENTS.lead_created, { async: true, promisify: true })
  async onLeadCreated(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('lead_created', p);
  }
  @OnEvent(DOMAIN_EVENTS.review_submitted, { async: true, promisify: true })
  async onReviewSubmitted(p: DomainEventPayload): Promise<void> {
    return this.handleEvent('review_submitted', p);
  }

  private async handleEvent(
    trigger: AutomationTriggerValue,
    payload: DomainEventPayload,
  ): Promise<void> {
    const rules = await this.admin.automationRule.findMany({
      where: { tenantId: payload.tenantId, trigger, isActive: true },
    });
    if (rules.length === 0) return;
    // Tras bajar a un plan sin automatizaciones, las reglas se conservan pero
    // no se ejecutan (igual que el FeatureGuard bloquea su gestión).
    if (!(await tenantHasFeature(this.admin, payload.tenantId, 'automations'))) {
      this.logger.log(
        `automations: tenant ${payload.tenantId} sin la funcionalidad; ${trigger} no se ejecuta`,
      );
      return;
    }
    for (const rule of rules) {
      const job: AutomationJobData = {
        tenantId: payload.tenantId,
        ruleId: rule.id,
        trigger,
        entityType: payload.entityType,
        entityId: payload.entityId,
        recipientEmail: payload.recipientEmail ?? null,
        recipientPhone: payload.recipientPhone ?? null,
        customerId: payload.customerId ?? null,
        leadId: payload.leadId ?? null,
        scope: payload.scope,
      };
      const delay = rule.delayMinutes > 0 ? rule.delayMinutes * 60_000 : 0;
      await this.queue.add(JOB_AUTOMATIONS_RUN, job, delay > 0 ? { delay } : {});
    }
  }

  /** Llamado por el worker (BullMQ). */
  async runJob(input: AutomationJobData): Promise<void> {
    let job = input;
    const rule = await this.admin.automationRule.findFirst({
      where: { id: job.ruleId, tenantId: job.tenantId, isActive: true },
    });
    if (!rule) {
      this.logger.warn(`Regla ${job.ruleId} inactiva/borrada, skip`);
      return;
    }
    const run = await this.admin.automationRun.create({
      data: {
        tenantId: job.tenantId,
        ruleId: job.ruleId,
        trigger: job.trigger,
        status: 'pending',
        entityType: job.entityType,
        entityId: job.entityId,
        eventPayload: job.scope as Prisma.InputJsonValue,
      },
    });
    try {
      // Completa destinatario y variables que el evento no trae (los eventos de
      // factura no llevan el inquilino; ninguno lleva el nombre del tenant).
      const ctx = await this.enrich(job);
      if (ctx.skipReason) {
        await this.markRun(run.id, 'skipped', ctx.skipReason);
        return;
      }
      job = { ...job, ...ctx.job };
      // Sin template no se puede enviar.
      if (!rule.templateId) {
        await this.markRun(run.id, 'skipped', 'rule sin templateId');
        return;
      }
      if (rule.actionType === 'send_email' && !job.recipientEmail) {
        await this.markRun(run.id, 'skipped', 'sin recipient email');
        return;
      }
      if (rule.actionType === 'send_whatsapp' && !job.recipientPhone) {
        await this.markRun(run.id, 'skipped', 'sin recipient phone');
        return;
      }
      const recipient =
        rule.actionType === 'send_email' ? job.recipientEmail! : job.recipientPhone!;
      const channel =
        rule.actionType === 'send_email'
          ? 'email'
          : rule.actionType === 'send_whatsapp'
            ? 'whatsapp'
            : 'sms';
      const comm = await this.communications.enqueue({
        tenantId: job.tenantId,
        channel: channel as 'email' | 'whatsapp' | 'sms',
        recipient,
        templateId: rule.templateId,
        variables: job.scope,
        ...(job.customerId ? { customerId: job.customerId } : {}),
        ...(job.leadId ? { leadId: job.leadId } : {}),
        ...(job.entityType === 'contract' ? { contractId: job.entityId } : {}),
        ...(job.entityType === 'invoice' ? { invoiceId: job.entityId } : {}),
        source: `automation:${rule.id}`,
        trigger: job.trigger,
      });
      await this.admin.automationRun.update({
        where: { id: run.id },
        data: { status: 'succeeded', finishedAt: new Date(), communicationId: comm.id },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markRun(run.id, 'failed', msg);
      throw err;
    }
  }

  /**
   * Rellena lo que falte en el job con datos de la BD: email/teléfono y datos
   * del inquilino, nombre y email del tenant y, para los eventos de factura,
   * importe pendiente, vencimiento y días de retraso. Lo que ya trae el evento
   * se respeta. Si la factura ya está pagada o anulada cuando toca enviar (regla
   * con retraso), el envío se descarta.
   */
  private async enrich(
    job: AutomationJobData,
  ): Promise<{ job: Partial<AutomationJobData>; skipReason?: string }> {
    const scope: Record<string, unknown> = { ...job.scope };
    const out: Partial<AutomationJobData> = {};

    const tenant = await this.admin.tenant.findUnique({
      where: { id: job.tenantId },
      select: { name: true, billingEmail: true },
    });
    scope.tenant = {
      name: tenant?.name ?? '',
      contactEmail: tenant?.billingEmail ?? '',
      ...asRecord(scope.tenant),
    };

    if (job.customerId) {
      const c = await this.admin.customer.findFirst({
        where: { id: job.customerId, tenantId: job.tenantId, deletedAt: null },
        select: {
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          companyName: true,
          customerType: true,
        },
      });
      if (c) {
        out.recipientEmail = job.recipientEmail ?? c.email ?? null;
        out.recipientPhone = job.recipientPhone ?? c.phone ?? null;
        const displayName =
          c.customerType === 'business'
            ? (c.companyName ?? '')
            : [c.firstName, c.lastName].filter(Boolean).join(' ');
        scope.customer = {
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          displayName,
          email: c.email ?? '',
          phone: c.phone ?? '',
          ...asRecord(scope.customer),
        };
      }
    }

    if (job.entityType === 'invoice') {
      const inv = await this.admin.invoice.findFirst({
        where: { id: job.entityId, tenantId: job.tenantId },
        select: {
          status: true,
          invoiceNumber: true,
          total: true,
          amountPaid: true,
          amountRefunded: true,
          dueDate: true,
        },
      });
      if (!inv) return { job: out, skipReason: 'factura no encontrada' };
      if (
        (job.trigger === 'invoice_issued' || job.trigger === 'invoice_overdue') &&
        (inv.status === 'paid' || inv.status === 'cancelled')
      ) {
        return { job: out, skipReason: `factura ${inv.status}` };
      }
      const pending = Number(inv.total) - Number(inv.amountPaid) - Number(inv.amountRefunded);
      const daysOverdue = inv.dueDate
        ? Math.max(0, Math.floor((Date.now() - inv.dueDate.getTime()) / 86_400_000))
        : 0;
      scope.invoice = {
        ...asRecord(scope.invoice),
        number: inv.invoiceNumber,
        total: Number(inv.total).toFixed(2),
        amountPending: Math.max(0, pending).toFixed(2),
        dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : '',
        daysOverdue,
      };
    }

    out.scope = scope;
    return { job: out };
  }

  private async markRun(
    runId: string,
    status: 'succeeded' | 'failed' | 'skipped',
    error?: string,
  ): Promise<void> {
    await this.admin.automationRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        ...(error ? { errorMessage: error.slice(0, 1000) } : {}),
      },
    });
  }

  // -----------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------

  private async findOrThrow(tenantId: string, id: string): Promise<AutomationRule> {
    const row = await this.prisma.withTenant(
      (tx) => tx.automationRule.findFirst({ where: { id } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'automation_rule_not_found',
        message: 'Regla no encontrada',
      });
    }
    return row;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      action,
      tenantId: args.tenantId,
      userId: args.userId,
      entityType: 'automation_rule',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  /** Últimas ejecuciones de las reglas (todas o de una), para ver qué se envió y qué se descartó. */
  async listRuns(tenantId: string, ruleId?: string): Promise<AutomationRunDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.automationRun.findMany({
          where: ruleId ? { ruleId } : {},
          orderBy: { startedAt: 'desc' },
          take: 50,
          include: { rule: { select: { name: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      ruleName: r.rule.name,
      trigger: r.trigger,
      status: r.status,
      entityType: r.entityType,
      entityId: r.entityId,
      communicationId: r.communicationId,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  }

  /**
   * La plantilla debe ser del tenant y del mismo canal que la acción; el SMS
   * aún no tiene proveedor (fallaría siempre).
   */
  private async assertAction(
    tenantId: string,
    actionType: string,
    templateId: string | null,
  ): Promise<void> {
    if (actionType === 'send_sms') {
      throw new BadRequestException({
        code: 'sms_not_available',
        message: 'El envío por SMS aún no está disponible',
      });
    }
    if (!templateId) {
      throw new BadRequestException({
        code: 'template_required',
        message: 'Elige la plantilla del mensaje',
      });
    }
    const tpl = await this.prisma.withTenant(
      (tx) =>
        tx.messageTemplate.findFirst({ where: { id: templateId }, select: { channel: true } }),
      tenantId,
    );
    if (!tpl) {
      throw new BadRequestException({
        code: 'template_not_found',
        message: 'Plantilla no encontrada',
      });
    }
    const expected = actionType === 'send_whatsapp' ? 'whatsapp' : 'email';
    if (tpl.channel !== expected) {
      throw new BadRequestException({
        code: 'template_channel_mismatch',
        message:
          expected === 'email'
            ? 'La plantilla elegida no es de email'
            : 'La plantilla elegida no es de WhatsApp',
      });
    }
  }

  private toDto(r: AutomationRule & { template?: { name: string } | null }): AutomationRuleDto {
    return {
      id: r.id,
      name: r.name,
      trigger: r.trigger,
      actionType: r.actionType,
      templateId: r.templateId,
      templateName: r.template?.name ?? null,
      conditions: (r.conditions ?? {}) as Record<string, unknown>,
      delayMinutes: r.delayMinutes,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

export type { AutomationJobData };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
