import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS } from '../automations/domain-events';

import { CollectionsService } from './collections.service';

import type { DomainEventPayload } from '../automations/domain-events';

/**
 * Cierra automáticamente el expediente de impago cuando el inquilino salda su
 * deuda (evento `invoice_paid`). El acceso electrónico ya lo reactiva
 * `AccessIntegrationsService` con el mismo evento; aquí cerramos el expediente
 * físico + avisamos de retirar el candado.
 */
@Injectable()
export class CollectionsListenersService {
  constructor(private readonly collections: CollectionsService) {}

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    if (!payload.customerId) return;
    await this.collections.onInvoicePaid(payload.tenantId, payload.customerId);
  }
}
