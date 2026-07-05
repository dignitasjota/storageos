import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { FilesModule } from '../files/files.module';
import { PaymentsModule } from '../payments/payments.module';

import { BillingSaasController } from './billing-saas.controller';
import { BillingSaasService } from './billing-saas.service';
import { BillingStatusController } from './billing-status.controller';
import { PlatformDunningController } from './platform-dunning.controller';
import { PlatformDunningCron } from './platform-dunning.cron';
import { PlatformDunningService } from './platform-dunning.service';
import { PlatformInvoicesController } from './platform-invoices.controller';
import { PlatformInvoicesService } from './platform-invoices.service';
import { SaasAddonsController } from './saas-addons.controller';
import { SaasAddonsService } from './saas-addons.service';
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
  controllers: [
    BillingSaasController,
    BillingStatusController,
    SubscriptionPlansController,
    SaasAddonsController,
    PlatformInvoicesController,
    PlatformDunningController,
  ],
  providers: [
    BillingSaasService,
    SubscriptionPlansService,
    SaasAddonsService,
    PlatformInvoicesService,
    PlatformDunningService,
    PlatformDunningCron,
    AdminGuard,
    // Auditoría del super admin sobre el catálogo de add-ons/planes. Solo
    // depende de PrismaAdminService (DatabaseModule es @Global), así que se
    // provee aquí en vez de importar AdminModule (evita el ciclo
    // AdminModule → BillingSaasModule → AdminModule). Instancia stateless.
    SuperAdminAuditService,
  ],
  exports: [
    BillingSaasService,
    SubscriptionPlansService,
    SaasAddonsService,
    PlatformInvoicesService,
    PlatformDunningService,
  ],
})
export class BillingSaasModule {}
