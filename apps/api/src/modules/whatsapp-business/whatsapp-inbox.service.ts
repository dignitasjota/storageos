import { randomUUID } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  WHATSAPP_SERVICE_WINDOW_HOURS,
  type WhatsappConversationDetailDto,
  type WhatsappConversationDto,
  type WhatsappMessageDto,
  type WhatsappMessageSender,
  type WhatsappMessageStatus,
  type SendWhatsappTemplateInput,
  WHATSAPP_MEDIA_LABELS,
  WHATSAPP_MEDIA_TYPES,
  WHATSAPP_OUTGOING_MAX_BYTES,
  type RequestWhatsappMediaUploadInput,
  type SendWhatsappMediaInput,
  type WhatsappMediaType,
  type WhatsappMediaUploadDto,
  type WhatsappMessageMediaDto,
  type WhatsappTemplatesDto,
} from '@storageos/shared';

import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { LeadsService } from '../leads/leads.service';
import { NotificationsService } from '../notifications/notifications.service';

import { WhatsappAssistantService } from './whatsapp-assistant.service';
import { WhatsappCloudClient, WhatsappCloudError } from './whatsapp-cloud.client';
import { extensionForMime, type ParsedInboundMessage } from './whatsapp-message-parse';
import { WhatsappSettingsService } from './whatsapp-settings.service';

const WINDOW_MS = WHATSAPP_SERVICE_WINDOW_HOURS * 60 * 60 * 1000;
const PREVIEW_LENGTH = 120;
/** Orden de los estados de entrega (un aviso atrasado no hace retroceder). */
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

export interface InboundWhatsappMessage {
  /** `phone_number_id` del número de destino (el del tenant). */
  phoneNumberId: string;
  /** Número del contacto (wa_id, solo cifras con prefijo). */
  from: string;
  /** Nombre del perfil de WhatsApp del contacto, si viene. */
  profileName: string | null;
  waMessageId: string;
  body: string;
  /** Foto, audio, vídeo, documento o sticker (se descarga en segundo plano). */
  media?: ParsedInboundMessage['media'] | undefined;
  receivedAt: Date;
}

type ConversationRow = Prisma.WhatsappConversationGetPayload<{
  include: { customer: { select: { firstName: true; lastName: true; companyName: true } } };
}>;

/**
 * Bandeja de WhatsApp Business: guarda lo que entra por el webhook (asignado al
 * tenant por su número), lo muestra en el panel y envía las respuestas del
 * equipo con las credenciales del propio tenant.
 */
@Injectable()
export class WhatsappInboxService {
  private readonly logger = new Logger(WhatsappInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly settings: WhatsappSettingsService,
    private readonly client: WhatsappCloudClient,
    private readonly leads: LeadsService,
    private readonly notifications: NotificationsService,
    private readonly assistant: WhatsappAssistantService,
    private readonly files: FilesService,
  ) {}

  /**
   * Mensaje entrante. Devuelve `false` si el número no es de ningún tenant
   * (entonces lo trata el flujo del número de la plataforma).
   */
  async handleInbound(msg: InboundWhatsappMessage): Promise<boolean> {
    const settings = await this.settings.resolveByPhoneNumberId(msg.phoneNumberId);
    if (!settings) return false;
    const { tenantId } = settings;
    // El número es del tenant: aunque no tenga el extra o lo tenga apagado, no
    // se pasa al flujo de la plataforma (no es un mensaje para ella).
    if (!settings.enabled || !(await tenantHasFeature(this.admin, tenantId, 'whatsapp_business'))) {
      this.logger.log(`whatsapp: mensaje para ${tenantId} sin el extra activo — ignorado`);
      return true;
    }
    const duplicate = await this.admin.whatsappMessage.findUnique({
      where: { waMessageId: msg.waMessageId },
      select: { id: true },
    });
    if (duplicate) return true;

    const waId = msg.from.replace(/\D/g, '');
    let conversation = await this.admin.whatsappConversation.findUnique({
      where: { tenantId_waId: { tenantId, waId } },
    });
    if (!conversation) {
      const customerId = await this.findCustomerByPhone(tenantId, waId);
      const leadId = customerId
        ? null
        : (
            await this.leads.createFromWhatsapp({
              tenantId,
              phone: `+${waId}`,
              name: msg.profileName,
              message: msg.body,
            })
          ).id;
      try {
        conversation = await this.admin.whatsappConversation.create({
          data: { tenantId, waId, contactName: msg.profileName, customerId, leadId },
        });
      } catch (err) {
        // Dos mensajes del mismo contacto a la vez: la otra petición la creó.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
        conversation = await this.admin.whatsappConversation.findUniqueOrThrow({
          where: { tenantId_waId: { tenantId, waId } },
        });
      }
    }

    let createdId: string;
    try {
      const created = await this.admin.whatsappMessage.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          direction: 'in',
          sender: 'contact',
          body: msg.body,
          waMessageId: msg.waMessageId,
          status: 'received',
          createdAt: msg.receivedAt,
          ...(msg.media
            ? {
                mediaType: msg.media.type,
                mediaMime: msg.media.mime,
                mediaFilename: msg.media.filename,
              }
            : {}),
        },
        select: { id: true },
      });
      createdId = created.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return true;
      throw err;
    }
    await this.admin.whatsappConversation.update({
      where: { id: conversation.id },
      data: {
        lastInboundAt: msg.receivedAt,
        lastMessageAt: msg.receivedAt,
        lastMessagePreview: msg.body.slice(0, PREVIEW_LENGTH),
        unreadCount: { increment: 1 },
        ...(msg.profileName && !conversation.contactName ? { contactName: msg.profileName } : {}),
      },
    });

    // Un aviso por conversación mientras quede algo sin leer (no uno por mensaje).
    if (conversation.unreadCount === 0) {
      await this.notifications
        .create(tenantId, {
          type: 'whatsapp.message',
          title: `WhatsApp de ${msg.profileName ?? `+${waId}`}`,
          body: msg.body.slice(0, PREVIEW_LENGTH),
          link: `/whatsapp?c=${conversation.id}`,
        })
        .catch(() => undefined);
    }

    if (msg.media) {
      void this.storeInboundMedia({
        tenantId,
        conversationId: conversation.id,
        messageId: createdId,
        mediaId: msg.media.id,
        mime: msg.media.mime,
        filename: msg.media.filename,
        accessToken: settings.accessToken,
      });
    }

    // El asistente (si está activo) responde en segundo plano: el webhook
    // tiene que contestar a Meta enseguida.
    void this.assistant.handleInbound({
      tenantId,
      conversationId: conversation.id,
      messageId: createdId,
    });
    return true;
  }

  /** Aviso de entrega de Meta para un mensaje enviado (sent/delivered/read/failed). */
  async handleStatus(args: {
    waMessageId: string;
    status: string;
    error: string | null;
  }): Promise<void> {
    const row = await this.admin.whatsappMessage.findUnique({
      where: { waMessageId: args.waMessageId },
      select: { id: true, status: true },
    });
    if (!row) return;
    if (args.status === 'failed') {
      await this.admin.whatsappMessage.update({
        where: { id: row.id },
        data: { status: 'failed', error: args.error ?? 'WhatsApp no pudo entregar el mensaje' },
      });
      return;
    }
    const next = STATUS_RANK[args.status];
    if (!next || (STATUS_RANK[row.status] ?? 0) >= next) return;
    await this.admin.whatsappMessage.update({
      where: { id: row.id },
      data: { status: args.status },
    });
  }

  async list(tenantId: string): Promise<WhatsappConversationDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.whatsappConversation.findMany({
          where: { tenantId },
          include: {
            customer: { select: { firstName: true, lastName: true, companyName: true } },
          },
          orderBy: { lastMessageAt: 'desc' },
          take: 200,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async unreadCount(tenantId: string): Promise<number> {
    const agg = await this.prisma.withTenant(
      (tx) =>
        tx.whatsappConversation.aggregate({ where: { tenantId }, _sum: { unreadCount: true } }),
      tenantId,
    );
    return agg._sum.unreadCount ?? 0;
  }

  /** Conversación con sus mensajes; al abrirla se marca como leída. */
  async detail(tenantId: string, id: string): Promise<WhatsappConversationDetailDto> {
    const row = await this.findOrThrow(tenantId, id);
    const messages = await this.prisma.withTenant(async (tx) => {
      if (row.unreadCount > 0) {
        await tx.whatsappConversation.update({ where: { id }, data: { unreadCount: 0 } });
      }
      return tx.whatsappMessage.findMany({
        where: { conversationId: id },
        include: { sentBy: { select: { fullName: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
      });
    }, tenantId);
    const urls = new Map<string, string>();
    await Promise.all(
      messages
        .filter((m) => m.mediaKey)
        .map(async (m) => {
          urls.set(m.id, await this.files.getPresignedGetUrl('uploads', m.mediaKey!, 600));
        }),
    );
    return {
      ...this.toDto({ ...row, unreadCount: 0 }),
      messages: messages.map((m) => this.toMessageDto(m, urls.get(m.id) ?? null)),
    };
  }

  /** Respuesta del equipo desde el panel. */
  async send(args: {
    tenantId: string;
    userId: string;
    conversationId: string;
    body: string;
  }): Promise<WhatsappMessageDto> {
    const conversation = await this.findOrThrow(args.tenantId, args.conversationId);
    const settings = await this.settings.resolveForTenant(args.tenantId);
    if (!settings?.enabled) {
      throw new BadRequestException({
        code: 'whatsapp_not_configured',
        message: 'Conecta y activa tu número de WhatsApp en Configuración',
      });
    }
    if (!this.windowOpen(conversation.lastInboundAt)) {
      throw new BadRequestException({
        code: 'whatsapp_window_closed',
        message: `Han pasado más de ${WHATSAPP_SERVICE_WINDOW_HOURS} h desde el último mensaje del contacto: WhatsApp solo deja responder con una plantilla aprobada`,
      });
    }

    let waMessageId: string | null = null;
    let error: string | null = null;
    try {
      waMessageId = (
        await this.client.sendText({
          phoneNumberId: settings.phoneNumberId,
          accessToken: settings.accessToken,
          to: conversation.waId,
          body: args.body,
        })
      ).messageId;
    } catch (err) {
      error = err instanceof WhatsappCloudError ? err.message : 'No se pudo enviar el mensaje';
    }

    const now = new Date();
    const message = await this.prisma.withTenant(async (tx) => {
      const created = await tx.whatsappMessage.create({
        data: {
          tenantId: args.tenantId,
          conversationId: conversation.id,
          direction: 'out',
          sender: 'staff',
          body: args.body,
          waMessageId,
          status: error ? 'failed' : 'sent',
          error,
          sentByUserId: args.userId,
          createdAt: now,
        },
        include: { sentBy: { select: { fullName: true } } },
      });
      if (!error) {
        await tx.whatsappConversation.update({
          where: { id: conversation.id },
          // Si responde una persona, el asistente deja de contestar en esta
          // conversación (se puede volver a activar desde la bandeja).
          data: {
            lastMessageAt: now,
            lastMessagePreview: args.body.slice(0, PREVIEW_LENGTH),
            assistantEnabled: false,
          },
        });
      }
      return created;
    }, args.tenantId);

    if (error) {
      throw new BadGatewayException({ code: 'whatsapp_send_failed', message: error });
    }
    return this.toMessageDto(message);
  }

  /**
   * Mensaje con plantilla aprobada (se puede enviar en cualquier momento; es
   * la única forma de escribir pasadas 24 h). Pausa el asistente igual que una
   * respuesta del equipo.
   */
  async sendTemplate(args: {
    tenantId: string;
    userId: string;
    conversationId: string;
    input: SendWhatsappTemplateInput;
  }): Promise<WhatsappMessageDto> {
    const conversation = await this.findOrThrow(args.tenantId, args.conversationId);
    const settings = await this.settings.resolveForTenant(args.tenantId);
    if (!settings?.enabled) {
      throw new BadRequestException({
        code: 'whatsapp_not_configured',
        message: 'Conecta y activa tu número de WhatsApp en Configuración',
      });
    }
    const body = `Plantilla «${args.input.name}»${
      args.input.params.length > 0 ? `: ${args.input.params.join(' · ')}` : ''
    }`;
    let waMessageId: string | null = null;
    let error: string | null = null;
    try {
      waMessageId = (
        await this.client.sendTemplate({
          phoneNumberId: settings.phoneNumberId,
          accessToken: settings.accessToken,
          to: conversation.waId,
          name: args.input.name,
          language: args.input.language,
          params: args.input.params,
        })
      ).messageId;
    } catch (err) {
      error = err instanceof WhatsappCloudError ? err.message : 'No se pudo enviar la plantilla';
    }
    const now = new Date();
    const message = await this.prisma.withTenant(async (tx) => {
      const created = await tx.whatsappMessage.create({
        data: {
          tenantId: args.tenantId,
          conversationId: conversation.id,
          direction: 'out',
          sender: 'staff',
          body,
          waMessageId,
          status: error ? 'failed' : 'sent',
          error,
          sentByUserId: args.userId,
          createdAt: now,
        },
        include: { sentBy: { select: { fullName: true } } },
      });
      if (!error) {
        await tx.whatsappConversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: now,
            lastMessagePreview: body.slice(0, PREVIEW_LENGTH),
            assistantEnabled: false,
          },
        });
      }
      return created;
    }, args.tenantId);
    if (error) throw new BadGatewayException({ code: 'whatsapp_send_failed', message: error });
    return this.toMessageDto(message);
  }

  /** Plantillas aprobadas en Meta (necesita el ID de la cuenta de WhatsApp Business). */
  async listTemplates(tenantId: string): Promise<WhatsappTemplatesDto> {
    const settings = await this.settings.resolveForTenant(tenantId);
    const row = await this.admin.tenantWhatsappSettings.findUnique({
      where: { tenantId },
      select: { wabaId: true },
    });
    if (!settings || !row?.wabaId) return { wabaConfigured: false, templates: [], error: null };
    try {
      return {
        wabaConfigured: true,
        templates: await this.client.listTemplates(row.wabaId, settings.accessToken),
        error: null,
      };
    } catch (err) {
      return {
        wabaConfigured: true,
        templates: [],
        error: err instanceof WhatsappCloudError ? err.message : 'No se pudo consultar a Meta',
      };
    }
  }

  /** URL firmada para subir un archivo que se enviará por WhatsApp. */
  async requestMediaUpload(args: {
    tenantId: string;
    conversationId: string;
    input: RequestWhatsappMediaUploadInput;
  }): Promise<WhatsappMediaUploadDto> {
    await this.findOrThrow(args.tenantId, args.conversationId);
    if (args.input.size > WHATSAPP_OUTGOING_MAX_BYTES[args.input.mimeType]) {
      throw new BadRequestException({
        code: 'file_too_large',
        message: `El archivo supera el máximo (${Math.round(
          WHATSAPP_OUTGOING_MAX_BYTES[args.input.mimeType] / 1024 / 1024,
        )} MB)`,
      });
    }
    const ext = extensionForMime(args.input.mimeType, null);
    const key = `${this.mediaPrefix(args.tenantId, args.conversationId)}out-${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: args.input.mimeType,
    });
    return { key, uploadUrl };
  }

  /** Envía un archivo ya subido (foto o PDF) desde la bandeja. */
  async sendMedia(args: {
    tenantId: string;
    userId: string;
    conversationId: string;
    input: SendWhatsappMediaInput;
  }): Promise<WhatsappMessageDto> {
    const { input } = args;
    const conversation = await this.findOrThrow(args.tenantId, args.conversationId);
    if (!input.key.startsWith(this.mediaPrefix(args.tenantId, conversation.id))) {
      throw new BadRequestException({ code: 'invalid_media_key', message: 'Archivo no válido' });
    }
    const settings = await this.settings.resolveForTenant(args.tenantId);
    if (!settings?.enabled) {
      throw new BadRequestException({
        code: 'whatsapp_not_configured',
        message: 'Conecta y activa tu número de WhatsApp en Configuración',
      });
    }
    if (!this.windowOpen(conversation.lastInboundAt)) {
      throw new BadRequestException({
        code: 'whatsapp_window_closed',
        message: `Han pasado más de ${WHATSAPP_SERVICE_WINDOW_HOURS} h desde el último mensaje del contacto: WhatsApp solo deja responder con una plantilla aprobada`,
      });
    }
    await this.files.assertObjectMimeType(
      'uploads',
      input.key,
      [input.mimeType],
      WHATSAPP_OUTGOING_MAX_BYTES[input.mimeType],
    );
    let bytes: Buffer;
    try {
      bytes = await this.files.getObject({ bucket: 'uploads', key: input.key });
    } catch {
      throw new BadRequestException({ code: 'media_not_uploaded', message: 'Sube el archivo' });
    }
    const type: WhatsappMediaType = input.mimeType === 'application/pdf' ? 'document' : 'image';
    const caption = input.caption?.trim() || undefined;

    let waMessageId: string | null = null;
    let error: string | null = null;
    try {
      waMessageId = (
        await this.client.sendMedia({
          phoneNumberId: settings.phoneNumberId,
          accessToken: settings.accessToken,
          to: conversation.waId,
          type: type === 'document' ? 'document' : 'image',
          bytes,
          mime: input.mimeType,
          filename: input.filename,
          caption,
        })
      ).messageId;
    } catch (err) {
      error = err instanceof WhatsappCloudError ? err.message : 'No se pudo enviar el archivo';
    }

    const label =
      type === 'document'
        ? `[${WHATSAPP_MEDIA_LABELS.document}: ${input.filename}]`
        : `[${WHATSAPP_MEDIA_LABELS.image}]`;
    const body = caption ? `${label} ${caption}` : label;
    const now = new Date();
    const message = await this.prisma.withTenant(async (tx) => {
      const created = await tx.whatsappMessage.create({
        data: {
          tenantId: args.tenantId,
          conversationId: conversation.id,
          direction: 'out',
          sender: 'staff',
          body,
          waMessageId,
          status: error ? 'failed' : 'sent',
          error,
          sentByUserId: args.userId,
          createdAt: now,
          mediaType: type,
          mediaKey: input.key,
          mediaMime: input.mimeType,
          mediaFilename: input.filename,
          mediaSize: bytes.length,
        },
        include: { sentBy: { select: { fullName: true } } },
      });
      if (!error) {
        await tx.whatsappConversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: now,
            lastMessagePreview: body.slice(0, PREVIEW_LENGTH),
            assistantEnabled: false,
          },
        });
      }
      return created;
    }, args.tenantId);
    if (error) throw new BadGatewayException({ code: 'whatsapp_send_failed', message: error });
    const url = await this.files.getPresignedGetUrl('uploads', input.key, 600);
    return this.toMessageDto(message, url);
  }

  /**
   * Descarga un archivo recibido y lo guarda en el almacenamiento privado. Si
   * falla (caducado, demasiado grande…), el mensaje queda con su etiqueta y
   * sin archivo.
   */
  private async storeInboundMedia(args: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    mediaId: string;
    mime: string | null;
    filename: string | null;
    accessToken: string;
  }): Promise<void> {
    try {
      const { bytes, mime } = await this.client.downloadMedia(args.mediaId, args.accessToken);
      const contentType = (args.mime ?? mime ?? 'application/octet-stream').split(';')[0]!.trim();
      const key = `${this.mediaPrefix(args.tenantId, args.conversationId)}${args.messageId}.${extensionForMime(
        contentType,
        args.filename,
      )}`;
      await this.files.putObject({ bucket: 'uploads', key, body: bytes, contentType });
      await this.admin.whatsappMessage.update({
        where: { id: args.messageId },
        data: { mediaKey: key, mediaSize: bytes.length, mediaMime: contentType },
      });
    } catch (err) {
      this.logger.warn(
        `whatsapp: no se pudo guardar el archivo ${args.mediaId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private mediaPrefix(tenantId: string, conversationId: string): string {
    return `${tenantId}/whatsapp/${conversationId}/`;
  }

  /** Activa o pausa el asistente en una conversación. */
  async setAssistant(
    tenantId: string,
    id: string,
    assistantEnabled: boolean,
  ): Promise<WhatsappConversationDto> {
    await this.findOrThrow(tenantId, id);
    await this.prisma.withTenant(
      (tx) => tx.whatsappConversation.update({ where: { id }, data: { assistantEnabled } }),
      tenantId,
    );
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  /** Busca un inquilino del tenant con ese teléfono (últimas 9 cifras). */
  private async findCustomerByPhone(tenantId: string, waId: string): Promise<string | null> {
    if (waId.length < 9) return null;
    const suffix = waId.slice(-9);
    // Solo cifras: el teléfono puede estar guardado con espacios o prefijo.
    const rows = await this.admin.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ${'%' + suffix}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  private async findOrThrow(tenantId: string, id: string): Promise<ConversationRow> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.whatsappConversation.findFirst({
          where: { id, tenantId },
          include: {
            customer: { select: { firstName: true, lastName: true, companyName: true } },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'conversation_not_found', message: 'No encontrada' });
    }
    return row;
  }

  private windowOpen(lastInboundAt: Date | null): boolean {
    return !!lastInboundAt && Date.now() - lastInboundAt.getTime() < WINDOW_MS;
  }

  private toDto(r: ConversationRow): WhatsappConversationDto {
    const customerName = r.customer
      ? r.customer.companyName ||
        [r.customer.firstName, r.customer.lastName].filter(Boolean).join(' ') ||
        null
      : null;
    return {
      id: r.id,
      waId: r.waId,
      contactName: r.contactName,
      customerId: r.customerId,
      customerName,
      leadId: r.leadId,
      lastMessageAt: r.lastMessageAt.toISOString(),
      lastMessagePreview: r.lastMessagePreview,
      unreadCount: r.unreadCount,
      lastInboundAt: r.lastInboundAt?.toISOString() ?? null,
      canReply: this.windowOpen(r.lastInboundAt),
      assistantEnabled: r.assistantEnabled,
      contractId: r.contractId,
    };
  }

  private toMessageDto(
    m: {
      id: string;
      direction: string;
      sender: string;
      body: string;
      status: string;
      error: string | null;
      createdAt: Date;
      sentBy: { fullName: string } | null;
      mediaType?: string | null;
      mediaMime?: string | null;
      mediaFilename?: string | null;
      mediaSize?: number | null;
    },
    mediaUrl: string | null = null,
  ): WhatsappMessageDto {
    const media: WhatsappMessageMediaDto | null =
      m.mediaType && (WHATSAPP_MEDIA_TYPES as readonly string[]).includes(m.mediaType)
        ? {
            type: m.mediaType as WhatsappMediaType,
            mime: m.mediaMime ?? null,
            filename: m.mediaFilename ?? null,
            size: m.mediaSize ?? null,
            url: mediaUrl,
          }
        : null;
    return {
      id: m.id,
      direction: m.direction === 'out' ? 'out' : 'in',
      sender: m.sender as WhatsappMessageSender,
      body: m.body,
      status: m.status as WhatsappMessageStatus,
      error: m.error,
      sentByName: m.sentBy?.fullName ?? null,
      createdAt: m.createdAt.toISOString(),
      media,
    };
  }
}
