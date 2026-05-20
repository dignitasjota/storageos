import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';

import { BillingSaasController } from './billing-saas.controller';
import { BillingSaasService } from './billing-saas.service';
import { SubscriptionPlansController } from './subscription-plans.controller';
import { SubscriptionPlansService } from './subscription-plans.service';

/**
 * Modulo de facturacion SaaS (Fase 8B) — Stripe Checkout + Billing Portal
 * para que el OWNER del tenant gestione su suscripcion a la plataforma.
 *
 * Diferencias clave con `PaymentsModule` (Fase 4):
 *   - PaymentsModule: gateway de cobros que los tenants usan contra sus
 *     inquilinos. Trabaja sobre `payments`/`invoices`/`payment_methods`.
 *   - BillingSaasModule: cobros que NOSOTROS hacemos a los tenants.
 *     Trabaja sobre `tenant_subscriptions`/`subscription_plans`.
 *
 * Dependencias circulares:
 *   - `PaymentsModule` (el `StripeWebhookController`) necesita llamar a
 *     `BillingSaasService.syncSubscriptionFromStripe` cuando llegan eventos
 *     de tipo `customer.subscription.*` o `invoice.payment_*`.
 *   - `BillingSaasModule` necesita el `StripeGateway` (cliente Stripe SDK)
 *     que vive en `PaymentsModule`.
 *   Resolvemos con `forwardRef` en ambos lados; ver `payments.module.ts`.
 */
@Module({
  imports: [AuthModule, forwardRef(() => PaymentsModule)],
  controllers: [BillingSaasController, SubscriptionPlansController],
  providers: [BillingSaasService, SubscriptionPlansService],
  exports: [BillingSaasService, SubscriptionPlansService],
})
export class BillingSaasModule {}
