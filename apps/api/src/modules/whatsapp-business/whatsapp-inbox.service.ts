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
} from '@storageos/shared';

import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { NotificationsService } from '../notifications/notifications.service';

import { WhatsappCloudClient, WhatsappCloudError } from './whatsapp-cloud.client';
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

    try {
      await this.admin.whatsappMessage.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          direction: 'in',
          sender: 'contact',
          body: msg.body,
          waMessageId: msg.waMessageId,
          status: 'received',
          createdAt: msg.receivedAt,
        },
      });
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
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
    }, tenantId);
    return {
      ...this.toDto({ ...row, unreadCount: 0 }),
      messages: messages.map((m) => this.toMessageDto(m)),
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
          data: { lastMessageAt: now, lastMessagePreview: args.body.slice(0, PREVIEW_LENGTH) },
        });
      }
      return created;
    }, args.tenantId);

    if (error) {
      throw new BadGatewayException({ code: 'whatsapp_send_failed', message: error });
    }
    return this.toMessageDto(message);
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
    };
  }

  private toMessageDto(m: {
    id: string;
    direction: string;
    sender: string;
    body: string;
    status: string;
    error: string | null;
    createdAt: Date;
    sentBy: { fullName: string } | null;
  }): WhatsappMessageDto {
    return {
      id: m.id,
      direction: m.direction === 'out' ? 'out' : 'in',
      sender: m.sender as WhatsappMessageSender,
      body: m.body,
      status: m.status as WhatsappMessageStatus,
      error: m.error,
      sentByName: m.sentBy?.fullName ?? null,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
