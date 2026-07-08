import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments.module';

import { GoCardlessCoreModule } from './gocardless-core.module';
import { GoCardlessEventsService } from './gocardless-events.service';
import { GoCardlessMandatesService } from './gocardless-mandates.service';
import { GoCardlessWebhookController } from './gocardless-webhook.controller';
import { GoCardlessController } from './gocardless.controller';

/**
 * GoCardless (domiciliación SEPA gestionada).
 *  - Fase 1: config por tenant cifrada + cliente HTTP `fetch` + webhook.
 *  - Fase 2: mandato vía Billing Request Flow (staff + portal) → `PaymentMethod`.
 *  - Fase 3: cobro de facturas (Payment) + despacho de eventos del webhook.
 *
 * El cliente/config/charge viven en `GoCardlessCoreModule` (sin deps de
 * Payments); aquí van el mandato (usa `PaymentMethodsService`), los settings y
 * el webhook (usa `PaymentsService`).
 */
@Module({
  imports: [GoCardlessCoreModule, PaymentsModule],
  controllers: [GoCardlessController, GoCardlessWebhookController],
  providers: [GoCardlessMandatesService, GoCardlessEventsService],
  exports: [GoCardlessMandatesService],
})
export class GoCardlessModule {}
