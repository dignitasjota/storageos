import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS } from '../automations/domain-events';

import { CollectionsService } from './collections.service';

import type { DomainEventPayload, InvoiceVoidedPayload } from '../automations/domain-events';

/**
 * Cierra automáticamente el expediente de impago cuando el inquilino salda su
 * deuda (`invoice_paid`) o la deuda se anula (`invoice_voided`). El acceso
 * electrónico ya lo reactiva `AccessIntegrationsService` con los mismos
 * eventos; aquí cerramos el expediente y avisamos de lo que queda por hacer.
 */
@Injectable()
export class CollectionsListenersService {
  constructor(private readonly collections: CollectionsService) {}

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    if (!payload.customerId) return;
    await this.collections.onInvoicePaid(payload.tenantId, payload.customerId);
  }

  @OnEvent(DOMAIN_EVENTS.invoice_voided, { async: true, promisify: true })
  async onInvoiceVoided(payload: InvoiceVoidedPayload): Promise<void> {
    await this.collections.onInvoiceVoided(payload.tenantId, payload.invoiceId);
  }
}
