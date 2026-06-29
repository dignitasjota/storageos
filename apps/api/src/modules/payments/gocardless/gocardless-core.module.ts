import { Module } from '@nestjs/common';

import { GoCardlessChargeService } from './gocardless-charge.service';
import { GoCardlessClient } from './gocardless-client';
import { GoCardlessSettingsService } from './gocardless-settings.service';

/**
 * Núcleo de GoCardless **sin dependencias de `PaymentsModule`**: cliente HTTP,
 * config por tenant y cobro (charge). Lo importa `PaymentsModule` (para que
 * `chargeInvoice` pueda cobrar por GoCardless) y `GoCardlessModule` (mandato +
 * settings + webhook), evitando el ciclo Payments↔GoCardless.
 */
@Module({
  providers: [GoCardlessClient, GoCardlessSettingsService, GoCardlessChargeService],
  exports: [GoCardlessClient, GoCardlessSettingsService, GoCardlessChargeService],
})
export class GoCardlessCoreModule {}
