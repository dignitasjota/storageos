import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';

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
    await this.findOrThrow(args.tenantId, args.id);
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
  async runJob(job: AutomationJobData): Promise<void> {
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
