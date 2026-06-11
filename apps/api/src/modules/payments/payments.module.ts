import { Module, forwardRef } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { BillingSaasModule } from '../billing-saas/billing-saas.module';

import { AutoChargeProcessor } from './auto-charge.processor';
import { AutoChargeService } from './auto-charge.service';
import { PAYMENT_GATEWAY } from './payment-gateway.interface';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeEventsCleanupCron } from './stripe-events-cleanup.cron';
import { StripeEventsService } from './stripe-events.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeGateway } from './stripe.gateway';

@Module({
  // forwardRef rompe el ciclo PaymentsModule <-> BillingSaasModule:
  // BillingSaas depende de StripeGateway (aqui dentro), y el
  // StripeWebhookController depende de BillingSaasService (alli).
  imports: [AuthModule, forwardRef(() => BillingSaasModule)],
  controllers: [PaymentMethodsController, PaymentsController, StripeWebhookController],
  providers: [
    StripeGateway,
    { provide: PAYMENT_GATEWAY, useExisting: StripeGateway },
    PaymentMethodsService,
    PaymentsService,
    StripeEventsService,
    // Listener de domain.invoice_issued: SIEMPRE en el API (encola); el
    // processor de la cola `payments` solo con workers activos.
    AutoChargeService,
    ...(WORKERS_ENABLED_IN_API ? [StripeEventsCleanupCron, AutoChargeProcessor] : []),
  ],
  exports: [PAYMENT_GATEWAY, StripeGateway, PaymentMethodsService, PaymentsService],
})
export class PaymentsModule {}
