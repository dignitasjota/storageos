import { Module } from '@nestjs/common';

import { GoCardlessClient } from './gocardless-client';
import { GoCardlessSettingsService } from './gocardless-settings.service';
import { GoCardlessWebhookController } from './gocardless-webhook.controller';
import { GoCardlessController } from './gocardless.controller';

/**
 * GoCardless (domiciliación SEPA gestionada). Fase 1: config por tenant cifrada
 * (access token + webhook secret) + cliente HTTP `fetch` + webhook con
 * verificación de firma. El mandato (Billing Request) y el cobro (Payment +
 * webhook → factura) llegan en fases posteriores.
 */
@Module({
  controllers: [GoCardlessController, GoCardlessWebhookController],
  providers: [GoCardlessClient, GoCardlessSettingsService],
  exports: [GoCardlessClient, GoCardlessSettingsService],
})
export class GoCardlessModule {}
