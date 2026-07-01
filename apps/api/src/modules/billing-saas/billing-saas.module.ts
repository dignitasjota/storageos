import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { FilesModule } from '../files/files.module';
import { PaymentsModule } from '../payments/payments.module';

import { BillingSaasController } from './billing-saas.controller';
import { BillingSaasService } from './billing-saas.service';
import { PlatformInvoicesController } from './platform-invoices.controller';
import { PlatformInvoicesService } from './platform-invoices.service';
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
 *
 * `JwtModule.register({})` + `AdminGuard` como provider: los endpoints de
 * gestion de planes en `SubscriptionPlansController` se protegen con
 * `AdminGuard` (super admin). El guard depende de `JwtService` (que no es
 * global) y `ConfigService` (global); registramos el JwtModule vacio aqui
 * igual que hace `AdminModule`, sin acoplar este modulo a todo `AdminModule`.
 */
@Module({
  imports: [
    AuthModule,
    forwardRef(() => PaymentsModule),
    JwtModule.register({}),
    EmailModule,
    FilesModule,
  ],
  controllers: [BillingSaasController, SubscriptionPlansController, PlatformInvoicesController],
  providers: [BillingSaasService, SubscriptionPlansService, PlatformInvoicesService, AdminGuard],
  exports: [BillingSaasService, SubscriptionPlansService, PlatformInvoicesService],
})
export class BillingSaasModule {}
