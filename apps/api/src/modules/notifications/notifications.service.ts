import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { NotificationListDto } from '@storageos/shared';

/** Lee `scope.<a>.<b>` como string si existe. */
function nested(scope: Record<string, unknown>, a: string, b: string): string | undefined {
  const obj = scope[a];
  if (obj && typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[b];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea una notificación del panel. `facilityId` (o, si no se sabe, el
   * contrato / factura / trastero del que se deduce) la limita a quien tiene
   * ese local; sin local, la ve toda la empresa.
   */
  async create(
    tenantId: string,
    input: {
      type: string;
      title: string;
      body?: string;
      link?: string;
      facilityId?: string | null;
      contractId?: string | null;
      invoiceId?: string | null;
      unitId?: string | null;
    },
  ): Promise<void> {
    const facilityId =
      input.facilityId ??
      (await this.facilityOf(tenantId, {
        contractId: input.contractId ?? null,
        invoiceId: input.invoiceId ?? null,
        unitId: input.unitId ?? null,
      }));
    await this.prisma.withTenant(
      (tx) =>
        tx.notification.create({
          data: {
            tenantId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
            facilityId,
          },
        }),
      tenantId,
    );
  }

  /** Local de un contrato, factura o trastero (null si no se sabe). */
  private async facilityOf(
    tenantId: string,
    ref: { contractId: string | null; invoiceId: string | null; unitId: string | null },
  ): Promise<string | null> {
    return this.prisma.withTenant(async (tx) => {
      if (ref.unitId) {
        const u = await tx.unit.findFirst({
          where: { id: ref.unitId },
          select: { facilityId: true },
        });
        if (u) return u.facilityId;
      }
      if (ref.contractId) {
        const c = await tx.contract.findFirst({
          where: { id: ref.contractId },
          select: { unit: { select: { facilityId: true } } },
        });
        if (c) return c.unit.facilityId;
      }
      if (ref.invoiceId) {
        const i = await tx.invoice.findFirst({
          where: { id: ref.invoiceId },
          select: {
            facilityId: true,
            contract: { select: { unit: { select: { facilityId: true } } } },
            productSale: { select: { facilityId: true } },
          },
        });
        if (i) {
          return i.contract?.unit.facilityId ?? i.facilityId ?? i.productSale?.facilityId ?? null;
        }
      }
      return null;
    }, tenantId);
  }

  /** Lo que ve el usuario: las de empresa y las de sus locales. */
  private visible(
    userId: string,
    facilityScope: string[] | null,
  ): { where: Prisma.NotificationWhereInput; unread: Prisma.NotificationWhereInput } {
    const where: Prisma.NotificationWhereInput = facilityScope
      ? { OR: [{ facilityId: null }, { facilityId: { in: facilityScope } }] }
      : {};
    return { where, unread: { ...where, reads: { none: { userId } } } };
  }

  async list(
    tenantId: string,
    viewer: { userId: string; facilityScope: string[] | null },
    limit = 20,
  ): Promise<NotificationListDto> {
    const { where, unread } = this.visible(viewer.userId, viewer.facilityScope);
    const [items, unreadCount] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.notification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: { reads: { where: { userId: viewer.userId }, select: { readAt: true } } },
          }),
          tx.notification.count({ where: unread }),
        ]),
      tenantId,
    );
    return {
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.reads[0]?.readAt.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
    };
  }

  async markRead(
    tenantId: string,
    viewer: { userId: string; facilityScope: string[] | null },
    id: string,
  ): Promise<void> {
    const { where } = this.visible(viewer.userId, viewer.facilityScope);
    await this.prisma.withTenant(async (tx) => {
      const n = await tx.notification.findFirst({ where: { ...where, id }, select: { id: true } });
      if (!n) return;
      await tx.notificationRead.createMany({
        data: [{ notificationId: id, userId: viewer.userId, tenantId }],
        skipDuplicates: true,
      });
    }, tenantId);
  }

  async markAllRead(
    tenantId: string,
    viewer: { userId: string; facilityScope: string[] | null },
  ): Promise<void> {
    const { unread } = this.visible(viewer.userId, viewer.facilityScope);
    await this.prisma.withTenant(async (tx) => {
      const pending = await tx.notification.findMany({ where: unread, select: { id: true } });
      if (pending.length === 0) return;
      await tx.notificationRead.createMany({
        data: pending.map((n) => ({ notificationId: n.id, userId: viewer.userId, tenantId })),
        skipDuplicates: true,
      });
    }, tenantId);
  }

  // --------------------------------------------------------------------------
  // Listeners de dominio → feed de actividad del tenant (best-effort).
  // --------------------------------------------------------------------------

  @OnEvent(DOMAIN_EVENTS.lead_created, { async: true, promisify: true })
  async onLeadCreated(p: DomainEventPayload): Promise<void> {
    const name = nested(p.scope, 'lead', 'name') ?? nested(p.scope, 'customer', 'displayName');
    await this.safe(p.tenantId, {
      type: 'lead.created',
      title: name ? `Nuevo lead: ${name}` : 'Nuevo lead',
      link: '/leads',
    });
  }

  @OnEvent(DOMAIN_EVENTS.invoice_overdue, { async: true, promisify: true })
  async onInvoiceOverdue(p: DomainEventPayload): Promise<void> {
    const num = nested(p.scope, 'invoice', 'number');
    await this.safe(p.tenantId, {
      type: 'invoice.overdue',
      title: num ? `Factura vencida ${num}` : 'Factura vencida',
      link: `/invoices/${p.entityId}`,
      invoiceId: p.entityId,
    });
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(p: DomainEventPayload): Promise<void> {
    const num = nested(p.scope, 'invoice', 'number');
    await this.safe(p.tenantId, {
      type: 'invoice.paid',
      title: num ? `Pago recibido — ${num}` : 'Pago recibido',
      link: `/invoices/${p.entityId}`,
      invoiceId: p.entityId,
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_ending_soon, { async: true, promisify: true })
  async onContractEndingSoon(p: DomainEventPayload): Promise<void> {
    const num = nested(p.scope, 'contract', 'number');
    const endDate = nested(p.scope, 'contract', 'endDate');
    await this.safe(p.tenantId, {
      type: 'contract.ending_soon',
      title: num ? `Contrato ${num} vence pronto` : 'Contrato vence pronto',
      ...(endDate ? { body: `Fecha de fin: ${endDate}` } : {}),
      link: `/contracts/${p.entityId}`,
      contractId: p.entityId,
    });
  }

  @OnEvent(DOMAIN_EVENTS.contract_move_out_requested, { async: true, promisify: true })
  async onMoveOutRequested(p: DomainEventPayload): Promise<void> {
    const num = nested(p.scope, 'contract', 'number');
    const endDate = nested(p.scope, 'contract', 'endDate');
    const who = nested(p.scope, 'customer', 'displayName');
    await this.safe(p.tenantId, {
      type: 'contract.move_out_requested',
      title: num ? `Baja solicitada — ${num}` : 'Baja solicitada por el inquilino',
      ...(endDate || who
        ? {
            body: `${who ? `${who} ` : ''}solicita la baja${endDate ? ` para el ${endDate}` : ''}.`,
          }
        : {}),
      link: `/contracts/${p.entityId}`,
      contractId: p.entityId,
    });
  }

  @OnEvent(DOMAIN_EVENTS.incident_created, { async: true, promisify: true })
  async onIncidentCreated(p: DomainEventPayload): Promise<void> {
    const title = nested(p.scope, 'incident', 'title') ?? nested(p.scope, 'incident', 'subject');
    const incident = await this.prisma.withTenant(
      (tx) =>
        tx.incident.findFirst({
          where: { id: p.entityId },
          select: { facilityId: true, unitId: true, contractId: true },
        }),
      p.tenantId,
    );
    await this.safe(p.tenantId, {
      facilityId: incident?.facilityId ?? null,
      unitId: incident?.unitId ?? null,
      contractId: incident?.contractId ?? null,
      type: 'incident.created',
      title: title ? `Nueva incidencia: ${title}` : 'Nueva incidencia',
      link: '/incidents',
    });
  }

  private async safe(
    tenantId: string,
    input: Parameters<NotificationsService['create']>[1],
  ): Promise<void> {
    try {
      await this.create(tenantId, input);
    } catch (err) {
      this.logger.warn(
        `[notifications] no se pudo crear (${input.type}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
