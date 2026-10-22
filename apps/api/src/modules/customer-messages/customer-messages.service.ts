import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import { chatReplyChannel } from '@storageos/shared';

import { DOMAIN_EVENTS, type CustomerMessagePayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';

import type { CustomerConversationDto, CustomerMessageDto } from '@storageos/shared';

const messageInclude = {
  sender: { select: { fullName: true } },
} satisfies Prisma.CustomerMessageInclude;

type MessageRow = Prisma.CustomerMessageGetPayload<{ include: typeof messageInclude }>;

function toDto(row: MessageRow): CustomerMessageDto {
  return {
    id: row.id,
    senderType: row.senderType as CustomerMessageDto['senderType'],
    channel: (row.channel ?? 'portal') as CustomerMessageDto['channel'],
    senderVerified: row.senderVerified,
    senderName: row.sender?.fullName ?? null,
    body: row.body,
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
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Mensajes de inquilinos que ESTE usuario aún no ha leído (badges del menú,
   * la lista de inquilinos y la ficha): total y por cliente. Cuenta los
   * posteriores a su última lectura de cada conversación (o a su alta, si
   * nunca la abrió: un usuario nuevo no hereda el historial como pendiente).
   */
  async unreadSummary(
    tenantId: string,
    userId: string,
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
   * reciente a la más antigua, con los no leídos de quien mira. Con locales
   * (filtro o alcance del usuario), solo inquilinos con algún contrato en ellos.
   */
  async conversations(
    tenantId: string,
    userId: string,
    facilityIds: string[] | null,
  ): Promise<CustomerConversationDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.$queryRaw<
        {
          customer_id: string;
          body: string;
          sender_type: string;
          channel: string;
          created_at: Date;
          customer_type: string;
          first_name: string | null;
          last_name: string | null;
          company_name: string | null;
          unread: number;
        }[]
      >`
        WITH last AS (
          SELECT DISTINCT ON (m.customer_id)
            m.customer_id, m.body, m.sender_type, m.channel, m.created_at
          FROM customer_messages m
          WHERE m.tenant_id = ${tenantId}::uuid
          ORDER BY m.customer_id, m.created_at DESC
        )
        SELECT l.customer_id, l.body, l.sender_type, l.channel, l.created_at,
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
        WHERE ${facilityIds}::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM contracts k
          JOIN units u ON u.id = k.unit_id
          WHERE k.customer_id = l.customer_id
            AND k.deleted_at IS NULL
            AND u.facility_id = ANY(${facilityIds}::uuid[])
        )
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
        body: r.body.length > 200 ? `${r.body.slice(0, 200)}…` : r.body,
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
          where: { tenantId, customerId, senderType: 'staff', readAt: null },
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

  /** Lista el hilo y marca como leídos los mensajes del lado contrario. */
  async list(
    tenantId: string,
    customerId: string,
    viewer: 'staff' | 'customer',
    /** Usuario del equipo que lo abre: su leído propio de esta conversación. */
    userId?: string,
  ): Promise<CustomerMessageDto[]> {
    await this.assertCustomer(tenantId, customerId);
    // El staff lee los del inquilino y viceversa.
    const otherSide = viewer === 'staff' ? 'customer' : 'staff';
    const rows = await this.prisma.withTenant(async (tx) => {
      await tx.customerMessage.updateMany({
        where: { tenantId, customerId, senderType: otherSide, readAt: null },
        data: { readAt: new Date() },
      });
      if (viewer === 'staff' && userId) {
        const now = new Date();
        await tx.customerMessageRead.upsert({
          where: { customerId_userId: { customerId, userId } },
          create: { customerId, userId, tenantId, lastReadAt: now },
          update: { lastReadAt: now },
        });
      }
      return tx.customerMessage.findMany({
        where: { tenantId, customerId },
        include: messageInclude,
        orderBy: { createdAt: 'asc' },
      });
    }, tenantId);
    return rows.map(toDto);
  }

  /** El staff responde al inquilino → push al inquilino. */
  async sendFromStaff(
    tenantId: string,
    customerId: string,
    userId: string,
    body: string,
  ): Promise<CustomerMessageDto> {
    await this.assertCustomer(tenantId, customerId);
    const { created, lastFromCustomer } = await this.prisma.withTenant(async (tx) => {
      const last = await tx.customerMessage.findFirst({
        where: { tenantId, customerId, senderType: 'customer' },
        orderBy: { createdAt: 'desc' },
        select: { channel: true, createdAt: true },
      });
      const row = await tx.customerMessage.create({
        data: { tenantId, customerId, senderType: 'staff', senderUserId: userId, body },
        include: messageInclude,
      });
      return { created: row, lastFromCustomer: last };
    }, tenantId);
    // Si escribió por WhatsApp o email, la respuesta sale también por ahí.
    const replyVia = lastFromCustomer
      ? chatReplyChannel([{ senderType: 'customer', ...lastFromCustomer }])
      : null;
    await this.push.sendToCustomer(tenantId, customerId, {
      title: 'Nuevo mensaje de tu gestor',
      body: body.slice(0, 140),
      url: '/portal/consume?tab=mensajes',
    });
    // Copia por correo (el push no llega a quien no lo activó).
    this.events.emit(DOMAIN_EVENTS.customer_message_from_staff, {
      tenantId,
      customerId,
      messageId: created.id,
      body,
      channel: 'portal',
      replyVia,
    } satisfies CustomerMessagePayload);
    return toDto(created);
  }

  /** El inquilino escribe desde el portal → notificación in-app al staff. */
  async sendFromCustomer(
    tenantId: string,
    customerId: string,
    body: string,
    channel: 'portal' | 'whatsapp' | 'email' = 'portal',
    /** `false` = email entrante sin DMARC `pass` (remitente no autenticado). */
    senderVerified = true,
  ): Promise<CustomerMessageDto> {
    const { name } = await this.assertCustomer(tenantId, customerId);
    const { created, alreadyPending } = await this.prisma.withTenant(async (tx) => {
      // ¿Ya había mensajes suyos sin leer? Entonces el equipo ya está avisado:
      // no repetimos notificación ni correo por cada frase.
      const pending = await tx.customerMessage.count({
        where: { tenantId, customerId, senderType: 'customer', readAt: null },
      });
      const row = await tx.customerMessage.create({
        data: { tenantId, customerId, senderType: 'customer', body, channel, senderVerified },
        include: messageInclude,
      });
      return { created: row, alreadyPending: pending > 0 };
    }, tenantId);
    if (!alreadyPending) {
      const via = channel === 'whatsapp' ? ' (WhatsApp)' : channel === 'email' ? ' (email)' : '';
      await this.notifications.create(tenantId, {
        type: 'customer.message',
        title: `Mensaje de ${name}${via}${senderVerified ? '' : ' — remitente no verificado'}`,
        body: body.slice(0, 140),
        link: `/customers/${customerId}?tab=chat`,
      });
      this.events.emit(DOMAIN_EVENTS.customer_message_from_customer, {
        tenantId,
        customerId,
        messageId: created.id,
        body,
        channel,
      } satisfies CustomerMessagePayload);
    }
    return toDto(created);
  }
}
