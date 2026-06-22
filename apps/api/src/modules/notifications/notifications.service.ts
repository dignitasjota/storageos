import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

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

  async create(
    tenantId: string,
    input: { type: string; title: string; body?: string; link?: string },
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.notification.create({
          data: {
            tenantId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
          },
        }),
      tenantId,
    );
  }

  async list(tenantId: string, limit = 20): Promise<NotificationListDto> {
    const [items, unreadCount] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.notification.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
          tx.notification.count({ where: { readAt: null } }),
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
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
    };
  }

  async markRead(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.notification.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } }),
      tenantId,
    );
  }

  async markAllRead(tenantId: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) => tx.notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } }),
      tenantId,
    );
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
    });
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(p: DomainEventPayload): Promise<void> {
    const num = nested(p.scope, 'invoice', 'number');
    await this.safe(p.tenantId, {
      type: 'invoice.paid',
      title: num ? `Pago recibido — ${num}` : 'Pago recibido',
      link: `/invoices/${p.entityId}`,
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
    });
  }

  @OnEvent(DOMAIN_EVENTS.incident_created, { async: true, promisify: true })
  async onIncidentCreated(p: DomainEventPayload): Promise<void> {
    const title = nested(p.scope, 'incident', 'title') ?? nested(p.scope, 'incident', 'subject');
    await this.safe(p.tenantId, {
      type: 'incident.created',
      title: title ? `Nueva incidencia: ${title}` : 'Nueva incidencia',
      link: '/incidents',
    });
  }

  private async safe(
    tenantId: string,
    input: { type: string; title: string; body?: string; link?: string },
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
