import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { JOB_COMMUNICATIONS_DISPATCH, QUEUE_COMMUNICATIONS } from '../queues/queues.module';

import { MessageTemplatesService } from './message-templates.service';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from './providers/whatsapp-provider';
import { renderTemplate, TEMPLATE_VARIABLES_BY_TRIGGER } from './template-engine';

import type { Communication, Prisma } from '@storageos/database';
import type {
  AutomationTriggerValue,
  CommunicationChannelValue,
  CommunicationDto,
  CommunicationStatusValue,
  SendCommunicationInput,
} from '@storageos/shared';

export interface DispatchJobData {
  tenantId: string;
  communicationId: string;
}

export interface ListFilters {
  channel?: CommunicationChannelValue;
  status?: CommunicationStatusValue;
  customerId?: string;
  leadId?: string;
  source?: string;
}

export interface SendArgs {
  tenantId: string;
  channel: CommunicationChannelValue;
  recipient: string;
  /** Plantilla (codigo o id) opcional para resolver subject + body. */
  templateCode?: string;
  templateId?: string;
  /** Si no se pasa template, debe venir bodyText (y opcional bodyHtml/subject). */
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  variables?: Record<string, unknown>;
  customerId?: string;
  leadId?: string;
  /** Nombre legible para tracking (e.g. "dunning.email_reminder"). */
  source?: string;
  scheduledFor?: Date;
  /** Si se pasa, restringe el render de variables a la whitelist del trigger. */
  trigger?: AutomationTriggerValue | 'manual';
}

/**
 * CommunicationsService: outbox + render + dispatch.
 *
 *   1. `enqueue(args)` crea fila `communications` con status=pending y
 *      bodyText/bodyHtml YA RENDERIZADOS (si vino templateCode/Id) y encola
 *      un job. Si `scheduledFor` viene, el job se atrasa.
 *   2. `dispatch(communicationId)` (llamado por el worker) toma la fila en
 *      pending, marca processing, llama al provider, marca sent/failed.
 *   3. Retries: BullMQ con backoff exponencial; cada fallo incrementa
 *      `retry_count`.
 */
@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly templates: MessageTemplatesService,
    private readonly email: EmailService,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    @InjectQueue(QUEUE_COMMUNICATIONS) private readonly queue: Queue,
  ) {}

  /**
   * API publica para enviar. Devuelve la communication persistida en estado
   * pending. El worker la marcara sent/failed.
   */
  async enqueue(args: SendArgs): Promise<CommunicationDto> {
    let subject = args.subject ?? null;
    let bodyText = args.bodyText ?? '';
    let bodyHtml = args.bodyHtml ?? null;
    let templateId: string | null = args.templateId ?? null;
    let templateName: string | null = null;
    let provider: string | null = null;

    if ((args.templateCode || args.templateId) && !bodyText) {
      const tpl = args.templateId
        ? await this.templates.findById(args.tenantId, args.templateId)
        : await this.templates.findByCode(args.tenantId, args.templateCode!);
      if (!tpl) {
        throw new NotFoundException({
          code: 'message_template_not_found',
          message: `Plantilla no encontrada`,
        });
      }
      templateId = tpl.id;
      templateName = tpl.name;
      const allowed = args.trigger
        ? (TEMPLATE_VARIABLES_BY_TRIGGER[args.trigger] ?? undefined)
        : undefined;
      subject = renderTemplate(tpl.subject ?? '', args.variables ?? {}, allowed);
      bodyText = renderTemplate(tpl.bodyText, args.variables ?? {}, allowed);
      bodyHtml = tpl.bodyHtml ? renderTemplate(tpl.bodyHtml, args.variables ?? {}, allowed) : null;
    }
    if (!bodyText) {
      throw new ConflictException({
        code: 'communication_body_required',
        message: 'Falta cuerpo (template o bodyText)',
      });
    }

    if (args.channel === 'email') provider = this.email.providerName;
    else if (args.channel === 'whatsapp') provider = this.whatsapp.name;
    else provider = 'unknown';

    const data: Prisma.CommunicationUncheckedCreateInput = {
      tenantId: args.tenantId,
      channel: args.channel,
      status: 'pending',
      templateId,
      customerId: args.customerId ?? null,
      leadId: args.leadId ?? null,
      recipient: args.recipient,
      subject,
      bodyText,
      bodyHtml,
      variables: (args.variables ?? {}) as Prisma.InputJsonValue,
      provider,
      source: args.source ?? null,
      scheduledFor: args.scheduledFor ?? null,
    };
    const created = await this.prisma.withTenant(
      (tx) => tx.communication.create({ data }),
      args.tenantId,
    );

    // Encolar dispatch. Si scheduledFor en el futuro, atrasar.
    const delay = args.scheduledFor ? Math.max(0, args.scheduledFor.getTime() - Date.now()) : 0;
    await this.queue.add(
      JOB_COMMUNICATIONS_DISPATCH,
      { tenantId: args.tenantId, communicationId: created.id } satisfies DispatchJobData,
      delay > 0 ? { delay } : {},
    );

    return this.toDto({ ...created, templateName });
  }

  /** Llamado por el worker (BullMQ) o por retry manual. */
  async dispatch(tenantId: string, communicationId: string): Promise<void> {
    const comm = await this.admin.communication.findFirst({
      where: { id: communicationId, tenantId },
    });
    if (!comm) {
      this.logger.warn(`dispatch: communication ${communicationId} no existe`);
      return;
    }
    if (comm.status !== 'pending' && comm.status !== 'failed') {
      this.logger.warn(
        `dispatch: communication ${communicationId} status=${comm.status}, ignorando`,
      );
      return;
    }
    // Lock optimista: marcar processing.
    await this.admin.communication.update({
      where: { id: comm.id },
      data: { status: 'processing' },
    });
    try {
      let providerMessageId: string | null = null;
      if (comm.channel === 'email') {
        const res = await this.email.sendRendered({
          to: comm.recipient,
          subject: comm.subject ?? '(sin asunto)',
          html: comm.bodyHtml ?? `<pre>${escapeHtml(comm.bodyText)}</pre>`,
          text: comm.bodyText,
          tags: { tenantId, communicationId },
        });
        providerMessageId = res.providerMessageId;
      } else if (comm.channel === 'whatsapp') {
        const res = await this.whatsapp.send({
          to: comm.recipient,
          body: comm.bodyText,
        });
        providerMessageId = res.providerMessageId;
      } else if (comm.channel === 'sms') {
        // Sin provider SMS en Fase 5: marcar failed con mensaje claro.
        throw new Error('SMS provider not configured (Fase 5 stub)');
      }
      await this.admin.communication.update({
        where: { id: comm.id },
        data: {
          status: 'sent',
          providerMessageId,
          sentAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`dispatch communication ${communicationId} fallo: ${message}`);
      await this.admin.communication.update({
        where: { id: comm.id },
        data: {
          status: 'failed',
          retryCount: { increment: 1 },
          failedAt: new Date(),
          errorMessage: message.slice(0, 1000),
        },
      });
      // No re-tirar el error para que BullMQ no lo retire si queremos retry manual.
      // Si se quiere reintento automatico, recolocar dejando throw.
      throw err;
    }
  }

  async list(tenantId: string, filters: ListFilters): Promise<CommunicationDto[]> {
    const where: Prisma.CommunicationWhereInput = {};
    if (filters.channel) where.channel = filters.channel;
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.leadId) where.leadId = filters.leadId;
    if (filters.source) where.source = filters.source;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.communication.findMany({
          where,
          include: { template: { select: { name: true } }, customer: true },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
      tenantId,
    );
    return rows.map((r) =>
      this.toDto({
        ...r,
        templateName: r.template?.name ?? null,
        customerName: r.customer ? customerDisplay(r.customer) : null,
      }),
    );
  }

  async detail(tenantId: string, id: string): Promise<CommunicationDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.communication.findFirst({
          where: { id },
          include: { template: { select: { name: true } }, customer: true },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'communication_not_found',
        message: 'No encontrado',
      });
    }
    return this.toDto({
      ...row,
      templateName: row.template?.name ?? null,
      customerName: row.customer ? customerDisplay(row.customer) : null,
    });
  }

  async retry(tenantId: string, id: string): Promise<CommunicationDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.communication.findFirst({ where: { id } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'communication_not_found',
        message: 'No encontrado',
      });
    }
    if (row.status !== 'failed' && row.status !== 'bounced') {
      throw new ConflictException({
        code: 'communication_not_retriable',
        message: 'Solo failed/bounced son reintentables',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.communication.update({
          where: { id },
          data: { status: 'pending', errorMessage: null },
        }),
      tenantId,
    );
    await this.queue.add(JOB_COMMUNICATIONS_DISPATCH, {
      tenantId,
      communicationId: id,
    } satisfies DispatchJobData);
    return this.detail(tenantId, id);
  }

  /** Cancela un envio en pending (e.g. el cliente pago antes del recordatorio). */
  async cancelPending(tenantId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.prisma.withTenant(
      (tx) =>
        tx.communication.updateMany({
          where: { id: { in: ids }, status: 'pending' },
          data: { status: 'skipped' },
        }),
      tenantId,
    );
    return result.count;
  }

  /**
   * Envia de inmediato (sin outbox/queue). Solo para flujos
   * cliente-en-espera (verificacion email, magic link portal, reset
   * password) donde el envio debe ser sincrono porque el usuario espera
   * el resultado. Igualmente persiste la communication para audit.
   */
  async sendImmediate(args: SendArgs): Promise<CommunicationDto> {
    const created = await this.enqueueWithoutJob(args);
    // dispatch puede tirar; deja la fila como failed y propaga al caller.
    await this.dispatch(args.tenantId, created.id);
    return this.detail(args.tenantId, created.id);
  }

  private async enqueueWithoutJob(args: SendArgs): Promise<CommunicationDto> {
    // Reutiliza la logica de render sin encolar.
    let subject = args.subject ?? null;
    let bodyText = args.bodyText ?? '';
    let bodyHtml = args.bodyHtml ?? null;
    let templateId: string | null = args.templateId ?? null;
    let provider: string | null = null;
    if ((args.templateCode || args.templateId) && !bodyText) {
      const tpl = args.templateId
        ? await this.templates.findById(args.tenantId, args.templateId)
        : await this.templates.findByCode(args.tenantId, args.templateCode!);
      if (!tpl) {
        throw new NotFoundException({
          code: 'message_template_not_found',
          message: `Plantilla no encontrada`,
        });
      }
      templateId = tpl.id;
      const allowed = args.trigger
        ? (TEMPLATE_VARIABLES_BY_TRIGGER[args.trigger] ?? undefined)
        : undefined;
      subject = renderTemplate(tpl.subject ?? '', args.variables ?? {}, allowed);
      bodyText = renderTemplate(tpl.bodyText, args.variables ?? {}, allowed);
      bodyHtml = tpl.bodyHtml ? renderTemplate(tpl.bodyHtml, args.variables ?? {}, allowed) : null;
    }
    if (args.channel === 'email') provider = this.email.providerName;
    else if (args.channel === 'whatsapp') provider = this.whatsapp.name;
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.communication.create({
          data: {
            tenantId: args.tenantId,
            channel: args.channel,
            status: 'pending',
            templateId,
            customerId: args.customerId ?? null,
            leadId: args.leadId ?? null,
            recipient: args.recipient,
            subject,
            bodyText,
            bodyHtml,
            variables: (args.variables ?? {}) as Prisma.InputJsonValue,
            provider,
            source: args.source ?? null,
          },
        }),
      args.tenantId,
    );
    return this.toDto(created);
  }

  async sendManual(args: {
    tenantId: string;
    input: SendCommunicationInput;
  }): Promise<CommunicationDto> {
    const body: SendArgs = {
      tenantId: args.tenantId,
      channel: args.input.channel,
      recipient: args.input.recipient,
      source: args.input.source ?? 'manual',
      variables: args.input.variables,
      trigger: 'manual',
    };
    if (args.input.templateId) body.templateId = args.input.templateId;
    if (args.input.subject) body.subject = args.input.subject;
    if (args.input.bodyText) body.bodyText = args.input.bodyText;
    if (args.input.bodyHtml) body.bodyHtml = args.input.bodyHtml;
    if (args.input.customerId) body.customerId = args.input.customerId;
    if (args.input.leadId) body.leadId = args.input.leadId;
    if (args.input.scheduledFor) body.scheduledFor = new Date(args.input.scheduledFor);
    return this.enqueue(body);
  }

  private toDto(
    c: Communication & { templateName?: string | null; customerName?: string | null },
  ): CommunicationDto {
    return {
      id: c.id,
      channel: c.channel,
      status: c.status,
      direction: c.direction,
      templateId: c.templateId,
      templateName: c.templateName ?? null,
      customerId: c.customerId,
      customerName: c.customerName ?? null,
      leadId: c.leadId,
      recipient: c.recipient,
      subject: c.subject,
      bodyText: c.bodyText,
      bodyHtml: c.bodyHtml,
      variables: (c.variables ?? {}) as Record<string, unknown>,
      providerMessageId: c.providerMessageId,
      provider: c.provider,
      source: c.source,
      errorMessage: c.errorMessage,
      retryCount: c.retryCount,
      scheduledFor: c.scheduledFor?.toISOString() ?? null,
      sentAt: c.sentAt?.toISOString() ?? null,
      deliveredAt: c.deliveredAt?.toISOString() ?? null,
      failedAt: c.failedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function customerDisplay(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}
