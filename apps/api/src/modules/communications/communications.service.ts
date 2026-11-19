import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  COMMUNICATION_CHANNEL_LABELS,
  COMMUNICATION_SOURCE_GROUPS,
  communicationSourceLabel,
  type CommunicationSourceGroup,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { CryptoService } from '../../common/crypto/crypto.service';
import { customerScopeWhere } from '../../common/customer-scope';
import { assertFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { leadScopeWhere } from '../../common/lead-scope';
import {
  appendUnsubscribeFooter,
  buildUnsubscribeToken,
  unsubscribeKey,
} from '../../common/marketing/unsubscribe-token';
import {
  extractBody,
  TENANT_SHELL_MARK,
  type TenantEmailBrand,
  tenantEmailShell,
  textToHtml,
} from '../../common/tenant-email-layout';
import {
  HELD_COMMUNICATION_MAX_AGE_MS,
  RELEASABLE_TENANT,
  isTenantSuspended,
} from '../../common/tenant-suspension';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailSuppressionsService } from '../email/email-suppressions.service';
import { EmailService } from '../email/email.service';
import { JOB_COMMUNICATIONS_DISPATCH, QUEUE_COMMUNICATIONS } from '../queues/queues.module';

import { BUILTIN_TEMPLATES } from './builtin-templates';
import { BUILTIN_TEMPLATES_EN } from './builtin-templates.en';
import { MessageTemplatesService } from './message-templates.service';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from './providers/whatsapp-provider';
import { extractSecrets, fillSecrets, maskSecrets, sealLinkTokens } from './secret-vars';
import { renderTemplate, renderText, TEMPLATE_VARIABLES_BY_TRIGGER } from './template-engine';
import { buildWhatsappTemplateParams } from './whatsapp-template.util';

import type { Env } from '../../config/env.schema';
import type { Communication, Prisma } from '@storageos/database';
import type {
  AutomationTriggerValue,
  CommunicationChannelValue,
  CommunicationDto,
  CommunicationPageDto,
  CommunicationStatsDto,
  CommunicationStatusValue,
  ProblemAddressDto,
  SendCommunicationInput,
} from '@storageos/shared';

/** Tras este tiempo en `processing`, un envío se considera atascado y se puede reclamar. */
const STUCK_PROCESSING_MS = 15 * 60_000;
function withoutStatus(f: PageFilters): PageFilters {
  const { status: _status, ...rest } = f;
  return rest;
}

const PROBLEM_LABELS: Record<string, string> = {
  hard_bounce: 'La dirección no existe',
  invalid_email: 'Dirección no válida',
  blocked: 'La bloquea su proveedor de correo',
  complaint: 'Marcó un correo como spam',
  bounced: 'Los correos rebotan',
};
/** Un envío pendiente sin salir pasado este tiempo se vuelve a encolar. */
const STUCK_PENDING_MS = 30 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DispatchJobData {
  tenantId: string;
  communicationId: string;
}

export interface ListFilters {
  /** Locales del usuario: solo ve los envíos de sus inquilinos y contactos. */
  scope?: FacilityScope;
  channel?: CommunicationChannelValue;
  status?: CommunicationStatusValue;
  customerId?: string;
  leadId?: string;
  contractId?: string;
  invoiceId?: string;
  source?: string;
}

/** Filtros del historial paginado (página de Comunicaciones). */
export interface PageFilters extends ListFilters {
  /** Destinatario, asunto o nombre del inquilino. */
  search?: string;
  /** Tipo de envío (campañas, facturas y cobros…). */
  sourceGroup?: CommunicationSourceGroup;
  /** Envíos de los inquilinos y contactos de este local. */
  facilityId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
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
  /** Dirección de respuesta propia (respuesta por correo dentro del hilo). */
  replyTo?: string;
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
    secrets: Record<string, string>;
  } {
    const vars = args.variables ?? {};
    if (!args.secretVariables?.length) {
      return { renderVars: vars, storedVars: vars, secrets: {} };
    }
    const { forRender, forStorage, secrets } = extractSecrets(vars, args.secretVariables);
    return { renderVars: forRender, storedVars: forStorage, secrets: secrets ?? {} };
  }

  /**
   * Tapa los enlaces con un código de acceso (firma, domiciliación, factura…)
   * y cifra todos los valores sensibles. El historial guarda las marcas; el
   * envío pone los valores reales (ver `secret-vars.ts`).
   */
  private seal(
    tenantId: string,
    texts: { subject: string | null; bodyText: string; bodyHtml: string | null },
    secrets: Record<string, string>,
  ): {
    subject: string | null;
    bodyText: string;
    bodyHtml: string | null;
    secretsEncrypted: string | null;
  } {
    const subject = texts.subject === null ? null : sealLinkTokens(texts.subject, secrets);
    const bodyText = sealLinkTokens(texts.bodyText, secrets);
    const bodyHtml = texts.bodyHtml === null ? null : sealLinkTokens(texts.bodyHtml, secrets);
    return {
      subject,
      bodyText,
      bodyHtml,
      secretsEncrypted:
        Object.keys(secrets).length > 0
          ? this.crypto.encryptString(JSON.stringify(secrets), tenantId)
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
    const { renderVars, storedVars, secrets } = this.splitSecrets(args);

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
      subject = renderText(src.subject ?? '', renderVars, allowed);
      bodyText = renderText(src.bodyText, renderVars, allowed);
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
    const sealed = this.seal(args.tenantId, { subject, bodyText, bodyHtml }, secrets);

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
      subject: sealed.subject,
      bodyText: sealed.bodyText,
      bodyHtml: sealed.bodyHtml,
      variables: storedVars as Prisma.InputJsonValue,
      secretsEncrypted: sealed.secretsEncrypted,
      whatsappTemplateName,
      whatsappTemplateLanguage,
      ...(whatsappTemplateParams
        ? { whatsappTemplateParams: whatsappTemplateParams as Prisma.InputJsonValue }
        : {}),
      provider,
      source: args.source ?? null,
      replyTo: args.replyTo ?? null,
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

  /**
   * Envíos en espera de tenants que ya pagaron: salen ahora; los que llevan
   * más de 30 días se omiten (una «nueva factura» de hace dos meses confunde).
   */
  async releaseHeld(): Promise<{ released: number; expired: number }> {
    const held = await this.admin.communication.findMany({
      where: { heldAt: { not: null }, status: 'pending', tenant: RELEASABLE_TENANT },
      select: { id: true, tenantId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    let released = 0;
    let expired = 0;
    const cutoff = Date.now() - HELD_COMMUNICATION_MAX_AGE_MS;
    for (const c of held) {
      if (c.createdAt.getTime() < cutoff) {
        const r = await this.admin.communication.updateMany({
          where: { id: c.id, heldAt: { not: null }, status: 'pending' },
          data: {
            heldAt: null,
            status: 'skipped',
            errorMessage: 'No se envió: la cuenta estuvo suspendida más de 30 días',
          },
        });
        expired += r.count;
        continue;
      }
      const r = await this.admin.communication.updateMany({
        where: { id: c.id, heldAt: { not: null }, status: 'pending' },
        data: { heldAt: null },
      });
      if (r.count === 0) continue;
      await this.queue.add(JOB_COMMUNICATIONS_DISPATCH, {
        tenantId: c.tenantId,
        communicationId: c.id,
      } satisfies DispatchJobData);
      released += 1;
    }
    return { released, expired };
  }

  /** Llamado por el worker (BullMQ) o por retry manual. */
  /** ¿Es la cuenta de demostración de los comerciales? */
  private async isDemoTenant(tenantId: string): Promise<boolean> {
    const settings = await this.admin.platformSalesSettings.findFirst({
      select: { demoTenantId: true },
    });
    return settings?.demoTenantId === tenantId;
  }

  async dispatch(tenantId: string, communicationId: string): Promise<void> {
    const comm = await this.admin.communication.findFirst({
      where: { id: communicationId, tenantId },
    });
    if (!comm) {
      this.logger.warn(`dispatch: communication ${communicationId} no existe`);
      return;
    }
    // La cuenta de demostración de los comerciales tiene inquilinos de ejemplo
    // (direcciones @example.com): no se les escribe nunca.
    if (comm.status === 'pending' && (await this.isDemoTenant(tenantId))) {
      await this.admin.communication.updateMany({
        where: { id: comm.id, status: 'pending' },
        data: { status: 'skipped', errorMessage: 'Cuenta de demostración: no se envía' },
      });
      return;
    }
    // Tenant suspendido: no se escribe a sus inquilinos. El envío queda en
    // espera (`heldAt`) y `releaseHeld` lo manda cuando pague.
    if (comm.status === 'pending' && (await isTenantSuspended(this.admin, tenantId))) {
      await this.admin.communication.updateMany({
        where: { id: comm.id, status: 'pending', heldAt: null },
        data: { heldAt: new Date() },
      });
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
        let text = this.unseal(tenantId, sealed, comm.bodyText);
        const rawHtml = comm.bodyHtml ? this.unseal(tenantId, sealed, comm.bodyHtml) : null;
        // Con la marca del tenant (logo y color). Lo que ya la lleva (correos
        // por defecto al inquilino) no se vuelve a envolver.
        let html =
          rawHtml && rawHtml.includes(TENANT_SHELL_MARK)
            ? rawHtml
            : tenantEmailShell(
                await this.tenantBrand(tenantId),
                rawHtml ? extractBody(rawHtml) : textToHtml(text),
              );
        let headers: Record<string, string> | undefined;
        if (comm.isMarketing) {
          const unsub = await this.unsubscribeParts(comm);
          if (unsub) {
            ({ html, text } = appendUnsubscribeFooter(
              { html, text },
              unsub.url,
              unsub.tenantName,
              await this.recipientLocale({
                tenantId,
                customerId: comm.customerId ?? undefined,
              }),
            ));
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
          ...(comm.replyTo ? { replyTo: { email: comm.replyTo } } : {}),
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
        // El inquilino pidió no recibir avisos por WhatsApp (área de clientes).
        if (comm.customerId) {
          const optOut = await this.admin.customer.findUnique({
            where: { id: comm.customerId },
            select: { whatsappOptOutAt: true },
          });
          if (optOut?.whatsappOptOutAt) {
            await this.admin.communication.update({
              where: { id: comm.id },
              data: {
                status: 'skipped',
                errorMessage: 'El inquilino no quiere avisos por WhatsApp',
              },
            });
            return;
          }
        }
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
        if (res.skipped) {
          await this.admin.communication.update({
            where: { id: comm.id },
            data: { status: 'skipped', errorMessage: res.skipped },
          });
          return;
        }
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
    const where: Prisma.CommunicationWhereInput = { ...communicationScopeWhere(filters.scope) };
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
    const campaigns = await this.campaignNames(tenantId, rows);
    return rows.map((r) =>
      this.toDto({
        ...r,
        templateName: r.template?.name ?? null,
        customerName: r.customer ? customerDisplay(r.customer) : null,
        campaignName: campaignOf(r.source, campaigns),
        ...linkFields(r),
      }),
    );
  }

  /** Nombres de las campañas de estos envíos (`source = campaign:<id>`). */
  private async campaignNames(
    tenantId: string,
    rows: Array<{ source: string | null }>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .map((r) => r.source)
          .filter((v): v is string => !!v && v.startsWith('campaign:'))
          .map((v) => v.slice('campaign:'.length))
          .filter((v) => UUID_RE.test(v)),
      ),
    ];
    if (ids.length === 0) return new Map();
    const found = await this.admin.campaign.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(found.map((c) => [c.id, c.name]));
  }

  /**
   * Envíos que se quedaron en «Pendiente» sin trabajo en la cola (Redis se
   * vació o se reinició a mitad): se vuelven a encolar. El envío se reclama de
   * forma atómica, así que un trabajo de más no manda el correo dos veces.
   */
  async requeueStuck(): Promise<number> {
    const cutoff = new Date(Date.now() - STUCK_PENDING_MS);
    const stuck = await this.admin.communication.findMany({
      where: {
        status: 'pending',
        heldAt: null,
        createdAt: { lt: cutoff },
        OR: [{ scheduledFor: null }, { scheduledFor: { lt: cutoff } }],
      },
      select: { id: true, tenantId: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    for (const c of stuck) {
      await this.queue.add(JOB_COMMUNICATIONS_DISPATCH, {
        tenantId: c.tenantId,
        communicationId: c.id,
      } satisfies DispatchJobData);
    }
    if (stuck.length > 0) this.logger.warn(`[communications] reencolados ${stuck.length}`);
    return stuck.length;
  }

  /**
   * Historial paginado por cursor (más recientes primero), con búsqueda y
   * rango de fechas. El listado simple (`list`, máx. 200) se mantiene para las
   * fichas y los filtros por recurso.
   */
  /** Filtros del historial (lista, cifras y CSV). */
  private pageWhere(f: PageFilters): Prisma.CommunicationWhereInput {
    if (f.facilityId) assertFacilityAllowed(f.scope, f.facilityId);
    const and: Prisma.CommunicationWhereInput[] = [communicationScopeWhere(f.scope)];
    const where: Prisma.CommunicationWhereInput = { AND: and };
    if (f.sourceGroup) {
      and.push({
        OR: COMMUNICATION_SOURCE_GROUPS[f.sourceGroup].prefixes.map((p) => ({
          source: { startsWith: p },
        })),
      });
    }
    if (f.facilityId) {
      and.push({
        OR: [
          {
            customer: {
              contracts: { some: { deletedAt: null, unit: { facilityId: f.facilityId } } },
            },
          },
          { contract: { unit: { facilityId: f.facilityId } } },
          { lead: { preferredFacilityId: f.facilityId } },
        ],
      });
    }
    if (f.channel) where.channel = f.channel;
    if (f.status) where.status = f.status;
    if (f.customerId) where.customerId = f.customerId;
    if (f.leadId) where.leadId = f.leadId;
    if (f.source) where.source = f.source;
    if (f.from || f.to) {
      where.createdAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: f.to } : {}) };
    }
    const q = f.search?.trim();
    if (q) {
      const contains = { contains: q, mode: 'insensitive' as const };
      and.push({
        OR: [
          { recipient: contains },
          { subject: contains },
          {
            customer: {
              OR: [{ firstName: contains }, { lastName: contains }, { companyName: contains }],
            },
          },
        ],
      });
    }
    return where;
  }

  async listPage(tenantId: string, f: PageFilters): Promise<CommunicationPageDto> {
    const take = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const where = this.pageWhere(f);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.communication.findMany({
          where,
          include: LIST_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: take + 1,
          ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
        }),
      tenantId,
    );
    const page = rows.slice(0, take);
    const campaigns = await this.campaignNames(tenantId, page);
    return {
      items: page.map((r) =>
        this.toDto({
          ...r,
          templateName: r.template?.name ?? null,
          customerName: r.customer ? customerDisplay(r.customer) : null,
          campaignName: campaignOf(r.source, campaigns),
          ...linkFields(r),
        }),
      ),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Cifras del historial con los mismos filtros (sin buscar por cursor). */
  async stats(tenantId: string, f: PageFilters): Promise<CommunicationStatsDto> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.communication.groupBy({
          by: ['status'],
          where: this.pageWhere(withoutStatus(f)),
          _count: { _all: true },
        }),
      tenantId,
    );
    const count = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
    return {
      total: rows.reduce((sum, r) => sum + r._count._all, 0),
      sent: count('sent'),
      delivered: count('delivered'),
      bounced: count('bounced'),
      failed: count('failed'),
      skipped: count('skipped'),
      pending: count('pending') + count('processing'),
    };
  }

  /** El historial con estos filtros en CSV (hasta 5.000 envíos). */
  async exportCsv(tenantId: string, f: PageFilters): Promise<string> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.communication.findMany({
          where: this.pageWhere(f),
          include: LIST_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5000,
        }),
      tenantId,
    );
    const campaigns = await this.campaignNames(tenantId, rows);
    const fmt = (d: Date | null) =>
      d
        ? new Intl.DateTimeFormat('es-ES', {
            timeZone: 'Europe/Madrid',
            dateStyle: 'short',
            timeStyle: 'short',
          }).format(d)
        : '';
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      [
        'Fecha',
        'Canal',
        'Destinatario',
        'Inquilino',
        'Asunto',
        'Tipo',
        'Estado',
        'Enviado',
        'Motivo',
      ],
      ...rows.map((r) => [
        fmt(r.createdAt),
        COMMUNICATION_CHANNEL_LABELS[r.channel] ?? r.channel,
        r.recipient,
        r.customer ? customerDisplay(r.customer) : '',
        maskSecrets(r.subject ?? ''),
        communicationSourceLabel(r.source, campaignOf(r.source, campaigns)),
        r.status,
        fmt(r.sentAt),
        r.errorMessage ?? '',
      ]),
    ];
    return `${String.fromCharCode(0xfeff)}${lines.map((l) => l.map(cell).join(';')).join('\r\n')}`;
  }

  /** Cancela un envío que aún no ha salido (p. ej. uno programado). */
  async cancel(
    tenantId: string,
    id: string,
    scope: FacilityScope,
    userId: string,
  ): Promise<CommunicationDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.communication.findFirst({ where: { id, ...communicationScopeWhere(scope) } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'communication_not_found', message: 'No encontrado' });
    }
    const user = await this.admin.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    const { count } = await this.admin.communication.updateMany({
      where: { id, tenantId, status: 'pending' },
      data: {
        status: 'skipped',
        errorMessage: `Cancelado por ${user?.fullName ?? 'el equipo'}`,
      },
    });
    if (count === 0) {
      throw new ConflictException({
        code: 'communication_not_cancellable',
        message: 'Solo se puede cancelar un envío que aún no ha salido',
      });
    }
    return this.detail(tenantId, id, scope);
  }

  /**
   * Cómo le llegó el correo (con la marca del negocio). Los enlaces con código
   * se ven tapados, como en el historial.
   */
  async previewHtml(tenantId: string, id: string, scope?: FacilityScope): Promise<string> {
    const row = await this.prisma.withTenant(
      (tx) => tx.communication.findFirst({ where: { id, ...communicationScopeWhere(scope) } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'communication_not_found', message: 'No encontrado' });
    }
    const raw = row.bodyHtml ? maskSecrets(row.bodyHtml) : null;
    if (raw && raw.includes(TENANT_SHELL_MARK)) return raw;
    return tenantEmailShell(
      await this.tenantBrand(tenantId),
      raw ? extractBody(raw) : textToHtml(maskSecrets(row.bodyText)),
    );
  }

  /**
   * Direcciones de inquilinos y contactos a las que no llegan los correos:
   * rebotan, no existen, las bloquea el proveedor o marcaron spam.
   */
  async problemAddresses(tenantId: string, scope: FacilityScope): Promise<ProblemAddressDto[]> {
    const [customers, leads] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.customer.findMany({
            where: { deletedAt: null, email: { not: null }, ...customerScopeWhere(scope ?? null) },
            select: {
              id: true,
              email: true,
              customerType: true,
              firstName: true,
              lastName: true,
              companyName: true,
            },
          }),
        tenantId,
      ),
      this.prisma.withTenant(
        (tx) =>
          tx.lead.findMany({
            where: { deletedAt: null, email: { not: null }, ...leadScopeWhere(scope ?? null) },
            select: { id: true, email: true, firstName: true, lastName: true, companyName: true },
          }),
        tenantId,
      ),
    ]);
    const byEmail = new Map<
      string,
      { customer?: (typeof customers)[number]; lead?: (typeof leads)[number] }
    >();
    for (const c of customers) {
      const k = c.email!.trim().toLowerCase();
      byEmail.set(k, { ...byEmail.get(k), customer: c });
    }
    for (const l of leads) {
      const k = l.email!.trim().toLowerCase();
      byEmail.set(k, { ...byEmail.get(k), lead: l });
    }
    if (byEmail.size === 0) return [];
    const emails = [...byEmail.keys()];
    const [suppressions, softBounces] = await Promise.all([
      this.admin.emailSuppression.findMany({
        where: { email: { in: emails }, OR: [{ tenantId }, { tenantId: null }] },
        orderBy: { createdAt: 'desc' },
      }),
      this.admin.communication.findMany({
        where: {
          tenantId,
          channel: 'email',
          status: 'bounced',
          createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) },
        },
        orderBy: { createdAt: 'desc' },
        select: { recipient: true, errorMessage: true, failedAt: true, createdAt: true },
        take: 2000,
      }),
    ]);
    const out = new Map<string, ProblemAddressDto>();
    const add = (email: string, reason: string, detail: string | null, since: Date) => {
      const who = byEmail.get(email);
      if (!who || out.has(email)) return;
      out.set(email, {
        email,
        reason,
        label: PROBLEM_LABELS[reason] ?? 'No le llegan los correos',
        detail,
        since: since.toISOString(),
        customerId: who.customer?.id ?? null,
        customerName: who.customer ? customerDisplay(who.customer) : null,
        leadId: who.lead?.id ?? null,
        leadName: who.lead
          ? [who.lead.firstName, who.lead.lastName].filter(Boolean).join(' ') ||
            who.lead.companyName ||
            null
          : null,
      });
    };
    for (const sup of suppressions) add(sup.email, sup.reason, sup.detail, sup.createdAt);
    for (const b of softBounces) {
      add(b.recipient.trim().toLowerCase(), 'bounced', b.errorMessage, b.failedAt ?? b.createdAt);
    }
    return [...out.values()].sort((a, b) => b.since.localeCompare(a.since));
  }

  async detail(tenantId: string, id: string, scope?: FacilityScope): Promise<CommunicationDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.communication.findFirst({
          where: { id, ...communicationScopeWhere(scope) },
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
    const campaigns = await this.campaignNames(tenantId, [row]);
    return this.toDto({
      ...row,
      templateName: row.template?.name ?? null,
      customerName: row.customer ? customerDisplay(row.customer) : null,
      campaignName: campaignOf(row.source, campaigns),
      ...linkFields(row),
    });
  }

  async retry(tenantId: string, id: string, scope?: FacilityScope): Promise<CommunicationDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.communication.findFirst({ where: { id, ...communicationScopeWhere(scope) } }),
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
    return this.detail(tenantId, id, scope);
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
    const code = tpl?.code ?? args.templateCode;
    const builtinEs = code ? BUILTIN_TEMPLATES.find((b) => b.code === code) : undefined;
    const english = code ? BUILTIN_TEMPLATES_EN[code] : undefined;
    // Inquilino en inglés y plantilla sin editar (igual a la de por defecto):
    // sale la versión inglesa. Si el tenant la editó, sale su texto.
    if (
      english &&
      builtinEs &&
      (!tpl || tpl.bodyText === builtinEs.bodyText) &&
      (await this.recipientLocale(args)) === 'en'
    ) {
      return {
        templateId: tpl?.id ?? null,
        name: tpl?.name ?? builtinEs.name,
        subject: english.subject,
        bodyText: english.bodyText,
        bodyHtml: english.bodyHtml,
      };
    }
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

  /** Idioma del inquilino destinatario (`es` si no hay inquilino). */
  private async recipientLocale(args: {
    tenantId: string;
    customerId?: string | undefined;
  }): Promise<'es' | 'en'> {
    if (!args.customerId) return 'es';
    const c = await this.admin.customer.findFirst({
      where: { id: args.customerId, tenantId: args.tenantId },
      select: { locale: true },
    });
    return c?.locale === 'en' ? 'en' : 'es';
  }

  private async enqueueWithoutJob(args: SendArgs): Promise<CommunicationDto> {
    // Reutiliza la logica de render sin encolar.
    let subject = args.subject ?? null;
    let bodyText = args.bodyText ?? '';
    let bodyHtml = args.bodyHtml ?? null;
    let templateId: string | null = args.templateId ?? null;
    let provider: string | null = null;
    const { renderVars, storedVars, secrets } = this.splitSecrets(args);
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
      subject = renderText(src.subject ?? '', renderVars, allowed);
      bodyText = renderText(src.bodyText, renderVars, allowed);
      bodyHtml = src.bodyHtml ? renderTemplate(src.bodyHtml, renderVars, allowed) : null;
    }
    if (args.channel === 'email') provider = this.email.providerName;
    else if (args.channel === 'whatsapp') provider = this.whatsapp.name;
    const sealed = this.seal(args.tenantId, { subject, bodyText, bodyHtml }, secrets);
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
            subject: sealed.subject,
            bodyText: sealed.bodyText,
            bodyHtml: sealed.bodyHtml,
            variables: storedVars as Prisma.InputJsonValue,
            secretsEncrypted: sealed.secretsEncrypted,
            provider,
            source: args.source ?? null,
          },
        }),
      args.tenantId,
    );
    return this.toDto(created);
  }

  private async tenantBrand(tenantId: string): Promise<TenantEmailBrand> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, portalLogoUrl: true, portalBrandColor: true },
    });
    return {
      name: t?.name ?? '',
      logoUrl: t?.portalLogoUrl ?? null,
      brandColor: t?.portalBrandColor ?? null,
    };
  }

  /** ¿Se puede enviar por WhatsApp? (simulador en producción = no). */
  get whatsappAvailable(): boolean {
    return this.whatsapp.available;
  }

  /**
   * Rechaza crear un envío por WhatsApp que no podría salir. Para las entradas
   * que crea el usuario (envío manual, automatizaciones, valoraciones); los
   * envíos ya creados se omiten al despachar.
   */
  assertWhatsappAvailable(): void {
    if (!this.whatsapp.available) {
      throw new BadRequestException({
        code: 'whatsapp_not_available',
        message: 'WhatsApp no está configurado en la plataforma: usa email.',
      });
    }
  }

  async sendManual(args: {
    tenantId: string;
    input: SendCommunicationInput;
  }): Promise<CommunicationDto> {
    if (args.input.channel === 'whatsapp') this.assertWhatsappAvailable();
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
      campaignName?: string | null;
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
      campaignName: c.campaignName ?? null,
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

function customerDisplay(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Envíos que ve quien solo tiene unos locales: los de sus inquilinos y
 * contactos, los de contratos de sus locales y los que no son de nadie.
 */
export function communicationScopeWhere(scope: FacilityScope): Prisma.CommunicationWhereInput {
  if (!scope) return {};
  return {
    OR: [
      { customerId: { not: null }, customer: customerScopeWhere(scope) },
      { customerId: null, leadId: { not: null }, lead: leadScopeWhere(scope) },
      {
        customerId: null,
        leadId: null,
        contractId: { not: null },
        contract: { unit: { facilityId: { in: scope } } },
      },
      { customerId: null, leadId: null, contractId: null },
    ],
  };
}

function campaignOf(source: string | null, names: Map<string, string>): string | null {
  return source?.startsWith('campaign:') ? (names.get(source.slice(9)) ?? null) : null;
}
