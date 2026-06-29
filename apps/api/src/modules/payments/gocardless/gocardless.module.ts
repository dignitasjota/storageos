import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments.module';

import { GoCardlessClient } from './gocardless-client';
import { GoCardlessMandatesService } from './gocardless-mandates.service';
import { GoCardlessSettingsService } from './gocardless-settings.service';
import { GoCardlessWebhookController } from './gocardless-webhook.controller';
import { GoCardlessController } from './gocardless.controller';

/**
 * GoCardless (domiciliación SEPA gestionada).
 *  - Fase 1: config por tenant cifrada + cliente HTTP `fetch` + webhook.
 *  - Fase 2: mandato vía Billing Request Flow (staff + portal) → `PaymentMethod`.
 * El cobro (Payment + webhook → factura) llega en la fase siguiente.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [GoCardlessController, GoCardlessWebhookController],
  providers: [GoCardlessClient, GoCardlessSettingsService, GoCardlessMandatesService],
  exports: [GoCardlessClient, GoCardlessSettingsService, GoCardlessMandatesService],
})
export class GoCardlessModule {}
