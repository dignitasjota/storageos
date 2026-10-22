import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import { chatReplyChannel } from '@storageos/shared';

import { DOMAIN_EVENTS, type CustomerMessagePayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';

import type { CustomerMessageDto } from '@storageos/shared';

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
   * Resumen de mensajes del inquilino sin leer por el staff (para los badges del
   * menú/lista/ficha): total y desglose por cliente.
   */
  async unreadSummary(
    tenantId: string,
  ): Promise<{ total: number; byCustomer: Record<string, number> }> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerMessage.groupBy({
          by: ['customerId'],
          where: { tenantId, senderType: 'customer', readAt: null },
          _count: { _all: true },
        }),
      tenantId,
    );
    const byCustomer: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byCustomer[r.customerId] = r._count._all;
      total += r._count._all;
    }
    return { total, byCustomer };
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
  ): Promise<CustomerMessageDto[]> {
    await this.assertCustomer(tenantId, customerId);
    // El staff lee los del inquilino y viceversa.
    const otherSide = viewer === 'staff' ? 'customer' : 'staff';
    const rows = await this.prisma.withTenant(async (tx) => {
      await tx.customerMessage.updateMany({
        where: { tenantId, customerId, senderType: otherSide, readAt: null },
        data: { readAt: new Date() },
      });
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
