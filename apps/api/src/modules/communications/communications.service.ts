import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { CryptoService } from '../../common/crypto/crypto.service';
import {
  appendUnsubscribeFooter,
  buildUnsubscribeToken,
  unsubscribeKey,
} from '../../common/marketing/unsubscribe-token';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailSuppressionsService } from '../email/email-suppressions.service';
import { EmailService } from '../email/email.service';
import { JOB_COMMUNICATIONS_DISPATCH, QUEUE_COMMUNICATIONS } from '../queues/queues.module';

import { BUILTIN_TEMPLATES } from './builtin-templates';
import { MessageTemplatesService } from './message-templates.service';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from './providers/whatsapp-provider';
import { extractSecrets, fillSecrets, maskSecrets } from './secret-vars';
import { renderTemplate, TEMPLATE_VARIABLES_BY_TRIGGER } from './template-engine';
import { buildWhatsappTemplateParams } from './whatsapp-template.util';

import type { Env } from '../../config/env.schema';
import type { Communication, Prisma } from '@storageos/database';
import type {
  AutomationTriggerValue,
  CommunicationChannelValue,
  CommunicationDto,
  CommunicationStatusValue,
  SendCommunicationInput,
} from '@storageos/shared';

/** Tras este tiempo en `processing`, un envío se considera atascado y se puede reclamar. */
const STUCK_PROCESSING_MS = 15 * 60_000;

export interface DispatchJobData {
  tenantId: string;
  communicationId: string;
}

export interface ListFilters {
  channel?: CommunicationChannelValue;
  status?: CommunicationStatusValue;
  customerId?: string;
  leadId?: string;
  contractId?: string;
  invoiceId?: string;
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
  /** Recurso que originó el envío (se enlaza desde /communications). */
  contractId?: string | null;
  invoiceId?: string | null;
  /** Nombre legible para tracking (e.g. "dunning.email_reminder"). */
  source?: string;
  scheduledFor?: Date;
  /** Si se pasa, restringe el render de variables a la whitelist del trigger. */
  trigger?: AutomationTriggerValue | 'manual';
  /**
   * Rutas de `variables` con valores sensibles (p. ej. `credential.secret`):
   * el correo los lleva, pero el historial guarda `••••` y el valor va cifrado.
   */
  secretVariables?: string[];
  /**
   * Comunicación comercial (campaña, win-back): lleva enlace y cabecera de baja
   * y se omite si el destinatario se ha dado de baja (LSSI art. 21).
   */
  marketing?: boolean;
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
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
    private readonly suppressions: EmailSuppressionsService,
  ) {}

  /**
   * ¿Puede recibir este correo comercial? Un cliente, mientras no se dé de baja;
   * un lead, solo con consentimiento y sin baja.
   */
  private async marketingBlocked(comm: Communication): Promise<string | null> {
    // Marcó como spam un correo de este tenant (o la dirección rebota).
    if (
      comm.channel === 'email' &&
      (await this.suppressions.blockedForMarketing(comm.tenantId, comm.recipient))
    ) {
      return 'El destinatario marcó como spam un correo anterior o su dirección rebota';
    }
    if (comm.customerId) {
      const c = await this.admin.customer.findFirst({
        where: { id: comm.customerId, tenantId: comm.tenantId },
        select: { marketingOptOutAt: true },
      });
      return c?.marketingOptOutAt
        ? 'El destinatario se ha dado de baja de las comunicaciones comerciales'
        : null;
    }
    if (comm.leadId) {
      const l = await this.admin.lead.findFirst({
        where: { id: comm.leadId, tenantId: comm.tenantId },
        select: { marketingConsentAt: true, marketingOptOutAt: true },
      });
      if (!l?.marketingConsentAt) return 'El contacto no ha dado su consentimiento comercial';
      if (l.marketingOptOutAt) {
        return 'El destinatario se ha dado de baja de las comunicaciones comerciales';
      }
      return null;
    }
    return 'Comunicación comercial sin cliente ni contacto asociado';
  }

  /** Pie y cabeceras de baja de un correo comercial. */
  private async unsubscribeParts(comm: Communication): Promise<{
    url: string;
    headers: Record<string, string>;
    tenantName: string;
  } | null> {
    const kind = comm.customerId ? 'c' : comm.leadId ? 'l' : null;
    const id = comm.customerId ?? comm.leadId;
    if (!kind || !id) return null;
    const token = buildUnsubscribeToken(
      unsubscribeKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true })),
      kind,
      id,
    );
    const tenant = await this.admin.tenant.findUnique({
      where: { id: comm.tenantId },
      select: { name: true },
    });
    const web = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const api = this.config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    // Baja en un clic (RFC 8058): el cliente de correo hace POST a la URL de la API.
    const oneClick = `${api}/v1/public/unsubscribe/${encodeURIComponent(token)}`;
    return {
      url: `${web}/unsubscribe/${encodeURIComponent(token)}`,
      tenantName: tenant?.name ?? '',
      headers: {
        'List-Unsubscribe': `<${oneClick}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  /**
   * Variables para renderizar y para guardar, y los valores sensibles cifrados
   * (ver `secret-vars.ts`).
   */
  private splitSecrets(args: SendArgs): {
    renderVars: Record<string, unknown>;
    storedVars: Record<string, unknown>;
    secretsEncrypted: string | null;
  } {
    const vars = args.variables ?? {};
    if (!args.secretVariables?.length) {
      return { renderVars: vars, storedVars: vars, secretsEncrypted: null };
    }
    const { forRender, forStorage, secrets } = extractSecrets(vars, args.secretVariables);
    return {
      renderVars: forRender,
      storedVars: forStorage,
      secretsEncrypted: secrets
        ? this.crypto.encryptString(JSON.stringify(secrets), args.tenantId)
        : null,
    };
  }

  /** Pone los valores sensibles reales en el texto (solo al enviar). */
  private unseal(tenantId: string, encrypted: string | null, text: string): string;
  private unseal(tenantId: string, encrypted: string | null, text: string | null): string | null;
  private unseal(tenantId: string, encrypted: string | null, text: string | null): string | null {
    if (!encrypted || text === null) return text;
    const secrets = JSON.parse(this.crypto.decryptString(encrypted, tenantId)) as Record<
      string,
      string
    >;
    return fillSecrets(text, secrets);
  }

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
    // Snapshot de plantilla WABA (solo cuando el canal es whatsapp y la
    // plantilla tiene una plantilla aprobada de Meta configurada).
    let whatsappTemplateName: string | null = null;
    let whatsappTemplateLanguage: string | null = null;
    let whatsappTemplateParams: Record<string, string> | null = null;
    const { renderVars, storedVars, secretsEncrypted } = this.splitSecrets(args);

    if ((args.templateCode || args.templateId) && !bodyText) {
      const src = await this.resolveTemplateSource(args);
      if (!src) {
        throw new NotFoundException({
          code: 'message_template_not_found',
          message: `Plantilla no encontrada`,
        });
      }
      templateId = src.templateId;
      templateName = src.name;
      const allowed = args.trigger
        ? (TEMPLATE_VARIABLES_BY_TRIGGER[args.trigger] ?? undefined)
        : undefined;
      subject = renderTemplate(src.subject ?? '', renderVars, allowed);
      bodyText = renderTemplate(src.bodyText, renderVars, allowed);
      bodyHtml = src.bodyHtml ? renderTemplate(src.bodyHtml, renderVars, allowed) : null;

      if (args.channel === 'whatsapp' && src.whatsappTemplateName) {
        whatsappTemplateName = src.whatsappTemplateName;
        whatsappTemplateLanguage = src.whatsappTemplateLanguage ?? null;
        whatsappTemplateParams = buildWhatsappTemplateParams(
          src.whatsappTemplateVariables ?? [],
          renderVars,
        );
      }
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
      contractId: args.contractId ?? null,
      invoiceId: args.invoiceId ?? null,
      recipient: args.recipient,
      subject,
      bodyText,
      bodyHtml,
      variables: storedVars as Prisma.InputJsonValue,
      secretsEncrypted,
      whatsappTemplateName,
      whatsappTemplateLanguage,
      ...(whatsappTemplateParams
        ? { whatsappTemplateParams: whatsappTemplateParams as Prisma.InputJsonValue }
        : {}),
      provider,
      source: args.source ?? null,
      scheduledFor: args.scheduledFor ?? null,
      isMarketing: args.marketing ?? false,
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
    // Reclamo ATÓMICO: solo un worker pasa de pending/failed a processing. Sin
    // esto, un reintento manual mientras BullMQ aún reintentaba (o dos jobs del
    // mismo envío) podían mandar el correo dos veces. Un envío que se quedó en
    // `processing` (el worker murió a mitad) se puede reclamar pasado un rato.
    const claimed = await this.admin.communication.updateMany({
      where: {
        id: comm.id,
        tenantId,
        OR: [
          { status: { in: ['pending', 'failed'] } },
          { status: 'processing', updatedAt: { lt: new Date(Date.now() - STUCK_PROCESSING_MS) } },
        ],
      },
      data: { status: 'processing' },
    });
    if (claimed.count === 0) {
      this.logger.warn(
        `dispatch: communication ${communicationId} status=${comm.status}, ignorando`,
      );
      return;
    }
    // Un correo comercial se omite si el destinatario se dio de baja (puede
    // haber pasado entre que se programó la campaña y el envío).
    if (comm.isMarketing) {
      const blocked = await this.marketingBlocked(comm);
      if (blocked) {
        await this.admin.communication.update({
          where: { id: comm.id },
          data: { status: 'skipped', errorMessage: blocked },
        });
        return;
      }
    }
    try {
      let providerMessageId: string | null = null;
      // Proveedor real que entregó el email (Brevo/Resend/SMTP, o el de respaldo).
      let deliveredBy: string | null = null;
      if (comm.channel === 'email') {
        const sealed = comm.secretsEncrypted;
        let html = this.unseal(
          tenantId,
          sealed,
          comm.bodyHtml ?? `<pre>${escapeHtml(comm.bodyText)}</pre>`,
        );
        let text = this.unseal(tenantId, sealed, comm.bodyText);
        let headers: Record<string, string> | undefined;
        if (comm.isMarketing) {
          const unsub = await this.unsubscribeParts(comm);
          if (unsub) {
            ({ html, text } = appendUnsubscribeFooter({ html, text }, unsub.url, unsub.tenantName));
            headers = unsub.headers;
          }
        }
        const res = await this.email.sendRendered({
          tenantId,
          to: comm.recipient,
          subject: this.unseal(tenantId, sealed, comm.subject ?? '(sin asunto)'),
          html,
          text,
          ...(headers ? { headers } : {}),
          tags: { tenantId, communicationId },
        });
        if (res.suppressed) {
          await this.admin.communication.update({
            where: { id: comm.id },
            data: { status: 'skipped', errorMessage: res.suppressed },
          });
          return;
        }
        providerMessageId = res.providerMessageId;
        deliveredBy = res.provider ?? null;
      } else if (comm.channel === 'whatsapp') {
        // Envío por plantilla aprobada (proactivo); si no hay, texto libre.
        const res = await this.whatsapp.send({
          to: comm.recipient,
          body: this.unseal(tenantId, comm.secretsEncrypted, comm.bodyText),
          ...(comm.whatsappTemplateName ? { templateName: comm.whatsappTemplateName } : {}),
          ...(comm.whatsappTemplateLanguage
            ? { templateLanguage: comm.whatsappTemplateLanguage }
            : {}),
          ...(comm.whatsappTemplateParams
            ? { templateVariables: comm.whatsappTemplateParams as Record<string, string> }
            : {}),
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
          ...(deliveredBy ? { provider: deliveredBy } : {}),
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
    if (filters.contractId) where.contractId = filters.contractId;
    if (filters.invoiceId) where.invoiceId = filters.invoiceId;
    if (filters.source) where.source = filters.source;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.communication.findMany({
          where,
          include: LIST_INCLUDE,
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
        ...linkFields(r),
      }),
    );
  }

  async detail(tenantId: string, id: string): Promise<CommunicationDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.communication.findFirst({
          where: { id },
          include: LIST_INCLUDE,
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
      ...linkFields(row),
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
    const stuck =
      row.status === 'processing' && row.updatedAt.getTime() < Date.now() - STUCK_PROCESSING_MS;
    if (row.status !== 'failed' && row.status !== 'bounced' && !stuck) {
      throw new ConflictException({
        code: 'communication_not_retriable',
        message: 'Solo failed/bounced (o atascados en processing) son reintentables',
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

  /**
   * Resuelve el contenido de la plantilla a partir de `templateId`/`templateCode`.
   * Busca primero la plantilla del tenant en BD y, si no existe pero hay un
   * `templateCode`, cae a la plantilla **built-in en código** (`BUILTIN_TEMPLATES`).
   * Así los emails del ciclo de vida (bienvenida, factura vencida, PIN de acceso…)
   * NO fallan en silencio cuando el tenant no tiene la fila sembrada (tenants
   * antiguos, o si el seed del alta no corrió). Devuelve `null` si no hay ninguna.
   */
  private async resolveTemplateSource(args: SendArgs): Promise<{
    templateId: string | null;
    name: string;
    subject: string | null;
    bodyText: string;
    bodyHtml: string | null;
    whatsappTemplateName?: string | null;
    whatsappTemplateLanguage?: string | null;
    whatsappTemplateVariables?: string[];
  } | null> {
    const tpl = args.templateId
      ? await this.templates.findById(args.tenantId, args.templateId)
      : args.templateCode
        ? await this.templates.findByCode(args.tenantId, args.templateCode)
        : null;
    if (tpl) {
      return {
        templateId: tpl.id,
        name: tpl.name,
        subject: tpl.subject,
        bodyText: tpl.bodyText,
        bodyHtml: tpl.bodyHtml,
        whatsappTemplateName: tpl.whatsappTemplateName,
        whatsappTemplateLanguage: tpl.whatsappTemplateLanguage,
        whatsappTemplateVariables: tpl.whatsappTemplateVariables,
      };
    }
    const builtin = args.templateCode
      ? BUILTIN_TEMPLATES.find((b) => b.code === args.templateCode)
      : undefined;
    if (builtin) {
      return {
        templateId: null,
        name: builtin.name,
        subject: builtin.subject,
        bodyText: builtin.bodyText,
        bodyHtml: builtin.bodyHtml ?? null,
      };
    }
    return null;
  }

  private async enqueueWithoutJob(args: SendArgs): Promise<CommunicationDto> {
    // Reutiliza la logica de render sin encolar.
    let subject = args.subject ?? null;
    let bodyText = args.bodyText ?? '';
    let bodyHtml = args.bodyHtml ?? null;
    let templateId: string | null = args.templateId ?? null;
    let provider: string | null = null;
    const { renderVars, storedVars, secretsEncrypted } = this.splitSecrets(args);
    if ((args.templateCode || args.templateId) && !bodyText) {
      const src = await this.resolveTemplateSource(args);
      if (!src) {
        throw new NotFoundException({
          code: 'message_template_not_found',
          message: `Plantilla no encontrada`,
        });
      }
      templateId = src.templateId;
      const allowed = args.trigger
        ? (TEMPLATE_VARIABLES_BY_TRIGGER[args.trigger] ?? undefined)
        : undefined;
      subject = renderTemplate(src.subject ?? '', renderVars, allowed);
      bodyText = renderTemplate(src.bodyText, renderVars, allowed);
      bodyHtml = src.bodyHtml ? renderTemplate(src.bodyHtml, renderVars, allowed) : null;
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
            contractId: args.contractId ?? null,
            invoiceId: args.invoiceId ?? null,
            recipient: args.recipient,
            subject,
            bodyText,
            bodyHtml,
            variables: storedVars as Prisma.InputJsonValue,
            secretsEncrypted,
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
    c: Communication & {
      templateName?: string | null;
      customerName?: string | null;
      contractNumber?: string | null;
      unitId?: string | null;
      unitCode?: string | null;
      invoiceNumber?: string | null;
    },
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
      contractId: c.contractId,
      contractNumber: c.contractNumber ?? null,
      unitId: c.unitId ?? null,
      unitCode: c.unitCode ?? null,
      invoiceId: c.invoiceId,
      invoiceNumber: c.invoiceNumber ?? null,
      recipient: c.recipient,
      subject: c.subject === null ? null : maskSecrets(c.subject),
      bodyText: maskSecrets(c.bodyText),
      bodyHtml: c.bodyHtml === null ? null : maskSecrets(c.bodyHtml),
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

const LIST_INCLUDE = {
  template: { select: { name: true } },
  customer: true,
  contract: { select: { contractNumber: true, unitId: true, unit: { select: { code: true } } } },
  invoice: { select: { invoiceNumber: true, status: true } },
} satisfies Prisma.CommunicationInclude;

/** Campos de enlace (contrato/trastero/factura) para el DTO. */
function linkFields(r: Prisma.CommunicationGetPayload<{ include: typeof LIST_INCLUDE }>): {
  contractNumber: string | null;
  unitId: string | null;
  unitCode: string | null;
  invoiceNumber: string | null;
} {
  return {
    contractNumber: r.contract?.contractNumber ?? null,
    unitId: r.contract?.unitId ?? null,
    unitCode: r.contract?.unit.code ?? null,
    // Un borrador lleva un número provisional `DRAFT-…`: no se muestra.
    invoiceNumber: r.invoice && r.invoice.status !== 'draft' ? r.invoice.invoiceNumber : null,
  };
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
