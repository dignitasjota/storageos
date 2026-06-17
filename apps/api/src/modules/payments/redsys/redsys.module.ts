import { Module } from '@nestjs/common';

import { BillingModule } from '../../billing/billing.module';

import { RedsysSettingsService } from './redsys-settings.service';
import { RedsysWebhookController } from './redsys-webhook.controller';
import { RedsysController } from './redsys.controller';
import { RedsysService } from './redsys.service';

/**
 * Redsys (TPV bancario, pasarela alojada). Config por tenant + generación del
 * formulario firmado + notificación servidor-a-servidor que marca la factura
 * pagada. Exporta `RedsysService` para que el portal del inquilino genere el
 * redirect de pago.
 */
@Module({
  imports: [BillingModule],
  controllers: [RedsysController, RedsysWebhookController],
  providers: [RedsysService, RedsysSettingsService],
  exports: [RedsysService],
})
export class RedsysModule {}
