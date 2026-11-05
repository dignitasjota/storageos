import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import {
  attachmentLabel,
  chatReplyChannel,
  DEFAULT_AUTO_REPLY,
  isWithinHours,
  MESSAGE_THREAD_PAGE,
  type MessageAttachmentInput,
  type MessageAttachmentUploadDto,
  type OpeningHours,
} from '@storageos/shared';

import { customerScopeSql, customerVisibilityFacilities } from '../../common/customer-scope';
import {
  assertAttachments,
  attachmentsDto,
  requestAttachmentUpload,
} from '../../common/message-attachments';
import { claimAlert } from '../admin/alert-state';
import { DOMAIN_EVENTS, type CustomerMessagePayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';
import { realtimeChannels, RealtimeService } from '../realtime/realtime.service';

import type { FacilityScope } from '../../common/facility-scope';
import type { CustomerConversationDto, CustomerMessageDto } from '@storageos/shared';

/** Como mucho un aviso al equipo por conversación en este tiempo. */
const TEAM_NOTICE_GAP_MINUTES = 15;
/** Recordatorio de lo que sigue sin respuesta: desde este tiempo… */
const UNANSWERED_AFTER_HOURS = 24;
/** …y hasta este (lo que se quedó muy atrás ya no se recuerda). */
const UNANSWERED_UNTIL_HOURS = 72;
/** El recordatorio de un mensaje sale una sola vez. */
const REMINDER_ONCE_MINUTES = 60 * 24 * 365;
/** La respuesta automática sale una vez por conversación en este tiempo. */
const AUTO_REPLY_GAP_MINUTES = 12 * 60;

const messageInclude = {
  sender: { select: { fullName: true } },
} satisfies Prisma.CustomerMessageInclude;

type MessageRow = Prisma.CustomerMessageGetPayload<{ include: typeof messageInclude }>;

function toDto(row: MessageRow): Omit<CustomerMessageDto, 'attachment' | 'attachments'> {
  return {
    id: row.id,
    senderType: row.senderType as CustomerMessageDto['senderType'],
    channel: (row.channel ?? 'portal') as CustomerMessageDto['channel'],
    senderVerified: row.senderVerified,
    senderName: row.sender?.fullName ?? null,
    body: row.body,
    isInternal: row.isInternal,
    isAuto: row.isAuto,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Chat bidireccional inquilino <-> staff. Un hilo por cliente. Funciona con
 * RLS (`withTenant`) tanto desde el panel staff como desde el portal (ambos
 * pasan el `tenantId` explícito). Al listar, marca como leídos los mensajes del
 * interlocutor; al enviar, avisa al otro lado (notificación in-app al staff,
 * push al inquilino).
 */
@Injectable()
export class CustomerMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
    private readonly events: EventEmitter2,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
  ) {}

  private async dto(row: MessageRow): Promise<CustomerMessageDto> {
    const attachments = await attachmentsDto(this.files, row);
    return { ...toDto(row), attachment: attachments[0] ?? null, attachments };
  }

  /** Avisa en vivo al equipo (a quien puede ver al inquilino) y al propio inquilino. */
  private async publish(tenantId: string, customerId: string, toCustomer = true): Promise<void> {
    await this.realtime.publish(realtimeChannels.tenant(tenantId), {
      type: 'customer_message',
      customerId,
      facilityIds: await customerVisibilityFacilities(this.admin, tenantId, customerId),
    });
    if (toCustomer) {
      await this.realtime.publish(realtimeChannels.customer(customerId), {
        type: 'customer_message',
      });
    }
  }

  /** Lo último en la conversación cambia su estado. */
  private setConversationStatus(
    tx: Prisma.TransactionClient,
    tenantId: string,
    customerId: string,
    status: 'pending' | 'answered',
  ) {
    return tx.customerConversation.upsert({
      where: { customerId },
      create: { customerId, tenantId, status },
      update: { status, closedAt: null },
    });
  }

  /** URL firmada para subir un adjunto a la conversación con un inquilino. */
  async requestAttachmentUpload(
    tenantId: string,
    customerId: string,
    mimeType: string,
  ): Promise<MessageAttachmentUploadDto> {
    await this.assertCustomer(tenantId, customerId);
    return requestAttachmentUpload(this.files, `${tenantId}/chat/${customerId}/`, mimeType);
  }

  private attachmentFields(tenantId: string, customerId: string, list: MessageAttachmentInput[]) {
    return assertAttachments(this.files, `${tenantId}/chat/${customerId}/`, list);
  }

  /**
   * Mensajes de inquilinos que ESTE usuario aún no ha leído (badges del menú,
   * la lista de inquilinos y la ficha): total y por cliente. Cuenta los
   * posteriores a su última lectura de cada conversación (o a su alta, si
   * nunca la abrió: un usuario nuevo no hereda el historial como pendiente).
   * Solo cuenta los inquilinos que puede ver.
   */
  async unreadSummary(
    tenantId: string,
    userId: string,
    scope: FacilityScope = null,
  ): Promise<{ total: number; byCustomer: Record<string, number> }> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<{ customer_id: string; n: number }[]>`
        SELECT m.customer_id, count(*)::int AS n
        FROM customer_messages m
        JOIN customers c ON c.id = m.customer_id AND c.deleted_at IS NULL
        LEFT JOIN customer_message_reads r
          ON r.customer_id = m.customer_id AND r.user_id = ${userId}::uuid
        WHERE m.tenant_id = ${tenantId}::uuid
          AND m.sender_type = 'customer'
          AND m.created_at > COALESCE(
            r.last_read_at,
            (SELECT u.created_at FROM users u WHERE u.id = ${userId}::uuid)
          )
          AND ${customerScopeSql(Prisma.sql`m.customer_id`, scope)}
        GROUP BY m.customer_id`,
      tenantId,
    );
    const byCustomer: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byCustomer[r.customer_id] = r.n;
      total += r.n;
    }
    return { total, byCustomer };
  }

  /**
   * Bandeja «Mensajes»: las conversaciones con su último mensaje, de la más
   * reciente a la más antigua, con los no leídos de quien mira. Quien solo ve
   * unos locales ve a los inquilinos que puede abrir; con un local elegido, solo
   * los que tienen algún contrato en él.
   */
  async conversations(
    tenantId: string,
    userId: string,
    scope: FacilityScope,
    facilityId: string | null,
  ): Promise<CustomerConversationDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<
        {
          customer_id: string;
          body: string;
          sender_type: string;
          channel: string;
          created_at: Date;
          attachment_name: string | null;
          customer_type: string;
          first_name: string | null;
          last_name: string | null;
          company_name: string | null;
          unread: number;
        }[]
      >`
        WITH last AS (
          SELECT DISTINCT ON (m.customer_id)
            m.customer_id, m.body, m.sender_type, m.channel, m.created_at, m.attachment_name
          FROM customer_messages m
          WHERE m.tenant_id = ${tenantId}::uuid AND NOT m.is_internal
          ORDER BY m.customer_id, m.created_at DESC
        )
        SELECT l.customer_id, l.body, l.sender_type, l.channel, l.created_at, l.attachment_name,
          c.customer_type::text AS customer_type, c.first_name, c.last_name, c.company_name,
          (
            SELECT count(*)::int FROM customer_messages x
            WHERE x.tenant_id = ${tenantId}::uuid
              AND x.customer_id = l.customer_id
              AND x.sender_type = 'customer'
              AND x.created_at > COALESCE(
                (SELECT r.last_read_at FROM customer_message_reads r
                  WHERE r.customer_id = l.customer_id AND r.user_id = ${userId}::uuid),
                (SELECT u.created_at FROM users u WHERE u.id = ${userId}::uuid)
              )
          ) AS unread
        FROM last l
        JOIN customers c ON c.id = l.customer_id AND c.deleted_at IS NULL
        WHERE ${customerScopeSql(Prisma.sql`l.customer_id`, scope)}
          AND (${facilityId}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM contracts k
            JOIN units u ON u.id = k.unit_id
            WHERE k.customer_id = l.customer_id
              AND k.deleted_at IS NULL
              AND u.facility_id = ${facilityId}::uuid
          ))
        ORDER BY l.created_at DESC
        LIMIT 200`,
      tenantId,
    );
    return rows.map((r) => ({
      customerId: r.customer_id,
      customerName:
        r.customer_type === 'business'
          ? (r.company_name ?? 'Empresa')
          : [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Cliente',
      lastMessage: {
        body: r.body
          ? r.body.length > 200
            ? `${r.body.slice(0, 200)}…`
            : r.body
          : r.attachment_name
            ? attachmentLabel(r.attachment_name)
            : '',
        senderType: r.sender_type as 'customer' | 'staff',
        channel: (r.channel ?? 'portal') as 'portal' | 'whatsapp' | 'email',
        createdAt: r.created_at.toISOString(),
      },
      unread: r.unread,
    }));
  }

  /** Mensajes del staff que el inquilino aún no ha leído (badge del portal). */
  async countUnreadForCustomer(tenantId: string, customerId: string): Promise<number> {
    return this.prisma.withTenant(
      (tx) =>
        tx.customerMessage.count({
          where: { tenantId, customerId, senderType: 'staff', isInternal: false, readAt: null },
        }),
      tenantId,
    );
  }

  private async assertCustomer(tenantId: string, customerId: string): Promise<{ name: string }> {
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: customerId, tenantId, deletedAt: null },
          select: { firstName: true, lastName: true, companyName: true, customerType: true },
        }),
      tenantId,
    );
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'Cliente no encontrado' });
    }
    const name =
      customer.customerType === 'business'
        ? (customer.companyName ?? 'Empresa')
        : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
    return { name };
  }

  /**
   * Los últimos mensajes del hilo, de más viejo a más nuevo, y marca como leídos
   * los del lado contrario. Con `before` (id de un mensaje), los anteriores a él.
   */
  async list(
    tenantId: string,
    customerId: string,
    viewer: 'staff' | 'customer',
    /** Usuario del equipo que lo abre: su leído propio de esta conversación. */
    userId?: string,
    before?: string,
  ): Promise<CustomerMessageDto[]> {
    await this.assertCustomer(tenantId, customerId);
    // El staff lee los del inquilino y viceversa.
    const otherSide = viewer === 'staff' ? 'customer' : 'staff';
    const rows = await this.prisma.withTenant(async (tx) => {
      if (!before) {
        const seen = await tx.customerMessage.updateMany({
          where: { tenantId, customerId, senderType: otherSide, isInternal: false, readAt: null },
          data: { readAt: new Date() },
        });
        // El equipo ve el «visto» en cuanto el inquilino lo abre.
        if (seen.count > 0 && viewer === 'customer') void this.publish(tenantId, customerId, false);
        if (viewer === 'staff' && userId) {
          const now = new Date();
          await tx.customerMessageRead.upsert({
            where: { customerId_userId: { customerId, userId } },
            create: { customerId, userId, tenantId, lastReadAt: now },
            update: { lastReadAt: now },
          });
        }
      }
      return tx.customerMessage.findMany({
        where: { tenantId, customerId, ...(viewer === 'customer' ? { isInternal: false } : {}) },
        include: messageInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MESSAGE_THREAD_PAGE,
        ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      });
    }, tenantId);
    return Promise.all(rows.reverse().map((r) => this.dto(r)));
  }

  /** El staff responde al inquilino → push al inquilino. Una nota solo la ve el equipo. */
  async sendFromStaff(
    tenantId: string,
    customerId: string,
    userId: string,
    body: string,
    attachments: MessageAttachmentInput[] = [],
    isInternal = false,
  ): Promise<CustomerMessageDto> {
    await this.assertCustomer(tenantId, customerId);
    const att = await this.attachmentFields(tenantId, customerId, attachments);
    // Lo que se cuenta en avisos y canales cuando el mensaje solo lleva adjunto.
    const text = body || (attachments[0] ? attachmentLabel(attachments[0].filename) : '');
    const { created, lastFromCustomer } = await this.prisma.withTenant(async (tx) => {
      const last = await tx.customerMessage.findFirst({
        where: { tenantId, customerId, senderType: 'customer' },
        orderBy: { createdAt: 'desc' },
        select: { channel: true, createdAt: true },
      });
      const row = await tx.customerMessage.create({
        data: {
          tenantId,
          customerId,
          senderType: 'staff',
          senderUserId: userId,
          body,
          isInternal,
          ...att,
        },
        include: messageInclude,
      });
      if (!isInternal) await this.setConversationStatus(tx, tenantId, customerId, 'answered');
      return { created: row, lastFromCustomer: last };
    }, tenantId);
    if (isInternal) {
      await this.publish(tenantId, customerId, false);
      return this.dto(created);
    }
    // Si escribió por WhatsApp o email, la respuesta sale también por ahí.
    const replyVia = lastFromCustomer
      ? chatReplyChannel([{ senderType: 'customer', ...lastFromCustomer }])
      : null;
    await this.push.sendToCustomer(tenantId, customerId, {
      title: 'Nuevo mensaje de tu gestor',
      body: text.slice(0, 140),
      url: '/portal/consume?tab=mensajes',
    });
    // Copia por correo (el push no llega a quien no lo activó).
    this.events.emit(DOMAIN_EVENTS.customer_message_from_staff, {
      tenantId,
      customerId,
      messageId: created.id,
      body: text,
      channel: 'portal',
      replyVia,
    } satisfies CustomerMessagePayload);
    await this.publish(tenantId, customerId);
    return this.dto(created);
  }

  /** El inquilino escribe desde el portal → notificación in-app al staff. */
  async sendFromCustomer(
    tenantId: string,
    customerId: string,
    body: string,
    channel: 'portal' | 'whatsapp' | 'email' = 'portal',
    /** `false` = email entrante sin DMARC `pass` (remitente no autenticado). */
    senderVerified = true,
    attachments: MessageAttachmentInput[] = [],
  ): Promise<CustomerMessageDto> {
    const { name } = await this.assertCustomer(tenantId, customerId);
    const att = await this.attachmentFields(tenantId, customerId, attachments);
    const text = body || (attachments[0] ? attachmentLabel(attachments[0].filename) : '');
    const created = await this.prisma.withTenant(async (tx) => {
      const row = await tx.customerMessage.create({
        data: {
          tenantId,
          customerId,
          senderType: 'customer',
          body,
          channel,
          senderVerified,
          ...att,
        },
        include: messageInclude,
      });
      await this.setConversationStatus(tx, tenantId, customerId, 'pending');
      return row;
    }, tenantId);
    // Un aviso por conversación cada poco: ni uno por frase ni silencio por no
    // haberla abierto nadie.
    const claimed = await claimAlert(
      this.admin,
      'customer_message',
      customerId,
      TEAM_NOTICE_GAP_MINUTES,
    );
    if (claimed) {
      const via = channel === 'whatsapp' ? ' (WhatsApp)' : channel === 'email' ? ' (email)' : '';
      await this.notifications.createForFacilities(
        tenantId,
        await customerVisibilityFacilities(this.admin, tenantId, customerId),
        {
          type: 'customer.message',
          title: `Mensaje de ${name}${via}${senderVerified ? '' : ' — remitente no verificado'}`,
          body: text.slice(0, 140),
          link: `/customers/${customerId}?tab=chat`,
        },
      );
      this.events.emit(DOMAIN_EVENTS.customer_message_from_customer, {
        tenantId,
        customerId,
        messageId: created.id,
        body: text,
        channel,
      } satisfies CustomerMessagePayload);
    }
    await this.publish(tenantId, customerId, false);
    await this.maybeAutoReply(tenantId, customerId, channel);
    return this.dto(created);
  }

  /** Fuera del horario de atención, el inquilino sabe que se le ha leído. */
  private async maybeAutoReply(
    tenantId: string,
    customerId: string,
    channel: 'portal' | 'whatsapp' | 'email',
  ): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        timezone: true,
        messageHours: true,
        messageAutoReply: true,
        messageAutoReplyEnabled: true,
      },
    });
    if (!tenant?.messageAutoReplyEnabled) return;
    const hours = tenant.messageHours as OpeningHours | null;
    if (isWithinHours(hours, tenant.timezone)) return;
    const claimed = await claimAlert(
      this.admin,
      'customer_message_auto',
      customerId,
      AUTO_REPLY_GAP_MINUTES,
    );
    if (!claimed) return;
    const body = tenant.messageAutoReply || DEFAULT_AUTO_REPLY;
    const auto = await this.prisma.withTenant(
      (tx) =>
        tx.customerMessage.create({
          data: { tenantId, customerId, senderType: 'staff', body, isAuto: true },
          select: { id: true },
        }),
      tenantId,
    );
    // Quien escribió desde el área de clientes lo ve ahí; por otro canal, sale por él.
    if (channel !== 'portal') {
      this.events.emit(DOMAIN_EVENTS.customer_message_from_staff, {
        tenantId,
        customerId,
        messageId: auto.id,
        body,
        channel: 'portal',
        replyVia: channel,
      } satisfies CustomerMessagePayload);
    }
    await this.publish(tenantId, customerId);
  }

  /**
   * Conversaciones cuyo último mensaje es del inquilino y lleva un día sin
   * respuesta: se recuerda una vez a quien puede verlas.
   */
  async remindUnanswered(): Promise<number> {
    const rows = await this.admin.$queryRaw<
      {
        id: string;
        tenant_id: string;
        customer_id: string;
        body: string;
        channel: string;
        attachment_name: string | null;
      }[]
    >`
      WITH last AS (
        SELECT DISTINCT ON (m.customer_id)
          m.id, m.tenant_id, m.customer_id, m.sender_type, m.body, m.channel,
          m.attachment_name, m.created_at
        FROM customer_messages m
        WHERE m.created_at > now() - make_interval(hours => ${UNANSWERED_UNTIL_HOURS}::int)
          AND NOT m.is_internal
          AND NOT m.is_auto
        ORDER BY m.customer_id, m.created_at DESC, m.id DESC
      )
      SELECT l.id, l.tenant_id, l.customer_id, l.body, l.channel, l.attachment_name
      FROM last l
      JOIN customers c ON c.id = l.customer_id AND c.deleted_at IS NULL
      JOIN tenants t ON t.id = l.tenant_id
      LEFT JOIN customer_conversations v ON v.customer_id = l.customer_id
      WHERE l.sender_type = 'customer'
        AND v.status IS DISTINCT FROM 'closed'
        AND l.created_at < now() - make_interval(hours => ${UNANSWERED_AFTER_HOURS}::int)
        AND t.deleted_at IS NULL
        AND t.status::text IN ('active', 'trial')
    `;
    let sent = 0;
    for (const row of rows) {
      const claimed = await claimAlert(
        this.admin,
        'customer_message_reminder',
        row.id,
        REMINDER_ONCE_MINUTES,
      );
      if (!claimed) continue;
      const { name } = await this.assertCustomer(row.tenant_id, row.customer_id);
      const text = row.body || (row.attachment_name ? attachmentLabel(row.attachment_name) : '');
      await this.notifications.createForFacilities(
        row.tenant_id,
        await customerVisibilityFacilities(this.admin, row.tenant_id, row.customer_id),
        {
          type: 'customer.message_unanswered',
          title: `${name} lleva un día sin respuesta`,
          body: text.slice(0, 140),
          link: `/customers/${row.customer_id}?tab=chat`,
        },
      );
      this.events.emit(DOMAIN_EVENTS.customer_message_from_customer, {
        tenantId: row.tenant_id,
        customerId: row.customer_id,
        messageId: row.id,
        body: text,
        channel: (row.channel ?? 'portal') as CustomerMessagePayload['channel'],
        reminder: true,
      } satisfies CustomerMessagePayload);
      sent += 1;
    }
    return sent;
  }
}
