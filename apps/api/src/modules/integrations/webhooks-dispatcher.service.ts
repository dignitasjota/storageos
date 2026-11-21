import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  type BookingCreatedPayload,
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type PaymentFailedPayload,
} from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { DOMAIN_TO_WEBHOOK_EVENT, LEGACY_WEBHOOK_ALIASES } from './webhook-events';
import { WebhooksService } from './webhooks.service';

import type { WebhookEventType } from '@storageos/shared';

/**
 * Listener dedicado que escucha eventos de dominio (`domain.X`) y los
 * convierte en deliveries para los webhooks salientes del tenant. Se
 * separa de `AutomationsService` (que tambien escucha) para no acoplar
 * ambos features.
 *
 * Si un evento de dominio no esta en `DOMAIN_TO_WEBHOOK_EVENT`, no se
 * propaga a webhooks (queda solo para automations internas).
 */
@Injectable()
export class WebhooksDispatcherService {
  private readonly logger = new Logger(WebhooksDispatcherService.name);

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly admin: PrismaAdminService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.invoice_issued, { async: true, promisify: true })
  async onInvoiceIssued(payload: DomainEventPayload): Promise<void> {
    return this.relay(DOMAIN_EVENTS.invoice_issued, payload);
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    return this.relay(DOMAIN_EVENTS.invoice_paid, payload);
  }

  @OnEvent(DOMAIN_EVENTS.invoice_overdue, { async: true, promisify: true })
  async onInvoiceOverdue(payload: DomainEventPayload): Promise<void> {
    return this.relay(DOMAIN_EVENTS.invoice_overdue, payload);
  }

  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(payload: DomainEventPayload): Promise<void> {
    return this.relay(DOMAIN_EVENTS.contract_signed, payload);
  }

  @OnEvent(DOMAIN_EVENTS.lead_created, { async: true, promisify: true })
  async onLeadCreated(payload: DomainEventPayload): Promise<void> {
    return this.relay(DOMAIN_EVENTS.lead_created, payload);
  }

  @OnEvent(DOMAIN_EVENTS.contract_move_out_requested, { async: true, promisify: true })
  async onMoveOutRequested(payload: DomainEventPayload): Promise<void> {
    return this.relay(DOMAIN_EVENTS.contract_move_out_requested, payload);
  }

  @OnEvent(DOMAIN_EVENTS.contract_ended, { async: true, promisify: true })
  async onContractEnded(payload: DomainEventPayload): Promise<void> {
    return this.relay(DOMAIN_EVENTS.contract_ended, payload);
  }

  /**
   * Reserva online: el evento solo trae ids, así que se completa con los
   * datos del contrato (solo si alguien está suscrito, para no consultar en
   * balde en cada reserva).
   */
  @OnEvent(DOMAIN_EVENTS.booking_created, { async: true, promisify: true })
  async onBookingCreated(p: BookingCreatedPayload): Promise<void> {
    try {
      if (!(await this.webhooks.hasSubscribers(p.tenantId, 'booking.created'))) return;
      const contract = await this.admin.contract.findFirst({
        where: { id: p.contractId, tenantId: p.tenantId },
        select: {
          contractNumber: true,
          status: true,
          startDate: true,
          priceMonthly: true,
          depositAmount: true,
          unit: { select: { code: true, facility: { select: { name: true } } } },
          customer: {
            select: {
              customerType: true,
              firstName: true,
              lastName: true,
              companyName: true,
              email: true,
              phone: true,
            },
          },
        },
      });
      if (!contract) return;
      const c = contract.customer;
      const displayName =
        c.customerType === 'business'
          ? (c.companyName ?? '')
          : [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
      await this.send(p.tenantId, 'booking.created', {
        tenantId: p.tenantId,
        entityType: 'contract',
        entityId: p.contractId,
        customerId: p.customerId,
        scope: {
          customer: {
            firstName: c.firstName ?? '',
            lastName: c.lastName ?? '',
            displayName,
            email: c.email ?? '',
            phone: c.phone ?? '',
          },
          contract: {
            number: contract.contractNumber,
            status: contract.status,
            startDate: contract.startDate.toISOString().slice(0, 10),
            priceMonthly: Number(contract.priceMonthly).toFixed(2),
            depositAmount: Number(contract.depositAmount).toFixed(2),
          },
          unit: { code: contract.unit.code },
          facility: { name: contract.unit.facility.name },
        },
        occurredAt: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(`booking.created no se envió: ${String(err)}`);
    }
  }

  /** Cobro rechazado: se añade el número de la factura (el evento solo trae su id). */
  @OnEvent(DOMAIN_EVENTS.payment_failed, { async: true, promisify: true })
  async onPaymentFailed(p: PaymentFailedPayload): Promise<void> {
    try {
      if (!(await this.webhooks.hasSubscribers(p.tenantId, 'payment.failed'))) return;
      const invoice = await this.admin.invoice.findFirst({
        where: { id: p.invoiceId, tenantId: p.tenantId },
        select: { invoiceNumber: true, total: true, currency: true },
      });
      await this.send(p.tenantId, 'payment.failed', {
        tenantId: p.tenantId,
        entityType: 'invoice',
        entityId: p.invoiceId,
        ...(p.customerId ? { customerId: p.customerId } : {}),
        scope: {
          invoice: {
            number: invoice?.invoiceNumber ?? '',
            total: invoice ? Number(invoice.total).toFixed(2) : '',
            currency: invoice?.currency ?? 'EUR',
          },
          payment: { amount: p.amount.toFixed(2), reason: p.reason },
        },
        occurredAt: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(`payment.failed no se envió: ${String(err)}`);
    }
  }

  private async relay(domainEvent: string, payload: DomainEventPayload): Promise<void> {
    const webhookEvent = DOMAIN_TO_WEBHOOK_EVENT[domainEvent];
    if (!webhookEvent) return;
    const data: Record<string, unknown> = {
      tenantId: payload.tenantId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      ...(payload.customerId ? { customerId: payload.customerId } : {}),
      ...(payload.leadId ? { leadId: payload.leadId } : {}),
      scope: payload.scope,
      occurredAt: new Date().toISOString(),
    };
    await this.send(payload.tenantId, webhookEvent, data);
  }

  private async send(
    tenantId: string,
    webhookEvent: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.webhooks.dispatch(tenantId, webhookEvent, data);
    for (const legacy of LEGACY_WEBHOOK_ALIASES[webhookEvent] ?? []) {
      await this.webhooks.dispatch(tenantId, legacy, data, { exceptEvent: webhookEvent });
    }
  }
}
