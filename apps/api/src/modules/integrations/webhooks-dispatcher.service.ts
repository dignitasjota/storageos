import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';

import { DOMAIN_TO_WEBHOOK_EVENT } from './webhook-events';
import { WebhooksService } from './webhooks.service';

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
  constructor(private readonly webhooks: WebhooksService) {}

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
    await this.webhooks.dispatch(payload.tenantId, webhookEvent, data);
  }
}
