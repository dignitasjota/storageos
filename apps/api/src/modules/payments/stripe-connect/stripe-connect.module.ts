import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';

import { PlatformPaymentSettingsService } from './platform-payment-settings.service';
import { StripeConnectClient } from './stripe-connect.client';
import { StripeConnectController } from './stripe-connect.controller';
import { StripeConnectService } from './stripe-connect.service';

/**
 * Stripe Connect (Express): cada tenant conecta su cuenta para cobrar con
 * tarjeta a sus inquilinos; la plataforma cobra una comisión por cobro.
 * Independiente de la suscripción a la plataforma (cuenta propia de TrasterOS).
 */
@Module({
  imports: [AuthModule],
  controllers: [StripeConnectController],
  providers: [StripeConnectClient, StripeConnectService, PlatformPaymentSettingsService],
  exports: [StripeConnectClient, StripeConnectService, PlatformPaymentSettingsService],
})
export class StripeConnectModule {}
