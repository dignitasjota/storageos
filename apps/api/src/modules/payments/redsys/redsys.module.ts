import { Module } from '@nestjs/common';

import { BillingModule } from '../../billing/billing.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { PaymentsModule } from '../payments.module';

import { RedsysCoreModule } from './redsys-core.module';
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
  imports: [BillingModule, NotificationsModule, PaymentsModule, RedsysCoreModule],
  controllers: [RedsysController, RedsysWebhookController],
  providers: [RedsysService],
  exports: [RedsysService],
})
export class RedsysModule {}
