import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { PAYMENT_GATEWAY } from './payment-gateway.interface';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeGateway } from './stripe.gateway';

@Module({
  imports: [AuthModule],
  controllers: [PaymentMethodsController, PaymentsController, StripeWebhookController],
  providers: [
    StripeGateway,
    { provide: PAYMENT_GATEWAY, useExisting: StripeGateway },
    PaymentMethodsService,
    PaymentsService,
  ],
  exports: [PAYMENT_GATEWAY, PaymentMethodsService, PaymentsService],
})
export class PaymentsModule {}
