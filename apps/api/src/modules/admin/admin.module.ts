import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../auth/auth.module';
import { BillingSaasModule } from '../billing-saas/billing-saas.module';
import { EmailModule } from '../email/email.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PlatformModule } from '../platform/platform.module';
import { TwoFactorModule } from '../two-factor/two-factor.module';

import { AdminCommsController } from './admin-comms.controller';
import { AdminCommsService } from './admin-comms.service';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';
import { AdminFollowupsController } from './admin-followups.controller';
import { AdminImpersonationAuditController } from './admin-impersonation-audit.controller';
import { AdminImpersonationAuditService } from './admin-impersonation-audit.service';
import { AdminMetricsController } from './admin-metrics.controller';
import { AdminMetricsService } from './admin-metrics.service';
import { AdminQueuesController } from './admin-queues.controller';
import { AdminSuperAdminsController } from './admin-super-admins.controller';
import { AdminSupportService } from './admin-support.service';
import { AdminSystemController } from './admin-system.controller';
import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminTodayController } from './admin-today.controller';
import { AdminTodayService } from './admin-today.service';
import { AdminGuard } from './admin.guard';
import { ImpersonationService } from './impersonation.service';
import { MrrModule } from './mrr.module';
import { PlatformAlertsController } from './platform-alerts.controller';
import { PlatformAlertsCron } from './platform-alerts.cron';
import { PlatformAlertsService } from './platform-alerts.service';
import { SecurityAlertsController } from './security-alerts.controller';
import { SecurityEventsController } from './security-events.controller';
import { SuperAdminAuditController } from './super-admin-audit.controller';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { SuperAdminAuthController } from './super-admin-auth.controller';
import { SuperAdminSessionsService } from './super-admin-sessions.service';
import { SuperAdminTwoFactorService } from './super-admin-two-factor.service';
import { SuperAdminService } from './super-admin.service';
import { SupportTicketsAdminController } from './support-tickets-admin.controller';
import { SupportTicketsTenantController } from './support-tickets-tenant.controller';
import { SupportTicketsService } from './support-tickets.service';
import { TenantLifecycleEmailsController } from './tenant-lifecycle-emails.controller';
import { TenantLifecycleEmailsCron } from './tenant-lifecycle-emails.cron';
import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';
import { WebhooksCleanupController } from './webhooks-cleanup.controller';
import { WeeklyDigestController } from './weekly-digest.controller';
import { WeeklyDigestCron } from './weekly-digest.cron';
import { WeeklyDigestService } from './weekly-digest.service';

/**
 * Modulo del panel super admin (Fase 8).
 *
 * - `AuthModule` aporta `AuditService` (logs centralizados).
 * - `DatabaseModule` es `@Global()`: `PrismaAdminService` queda accesible.
 * - `JwtModule.register({})` registra un JwtService sin secret por defecto:
 *   los servicios (super-admin, impersonation) pasan `secret` explicito al
 *   firmar/verificar, con `SUPER_ADMIN_JWT_SECRET` o `JWT_ACCESS_SECRET`
 *   segun corresponda.
 *
 * IMPORTANTE: el wiring en `AppModule` lo hace el desarrollador a mano.
 */
@Module({
  imports: [
    AuthModule,
    PlatformModule,
    TwoFactorModule,
    JwtModule.register({}),
    IntegrationsModule,
    BillingSaasModule,
    EmailModule,
    MrrModule,
  ],
  controllers: [
    AdminCommsController,
    SuperAdminAuthController,
    AdminTenantsController,
    AdminMetricsController,
    AdminQueuesController,
    AdminSystemController,
    SecurityEventsController,
    SecurityAlertsController,
    SuperAdminAuditController,
    AdminSuperAdminsController,
    PlatformAlertsController,
    AdminImpersonationAuditController,
    SupportTicketsAdminController,
    SupportTicketsTenantController,
    WebhooksCleanupController,
    AdminFollowupsController,
    AdminTodayController,
    AdminFinanceController,
    TenantLifecycleEmailsController,
    WeeklyDigestController,
  ],
  providers: [
    AdminGuard,
    PlatformAlertsService,
    PlatformAlertsCron,
    WeeklyDigestService,
    WeeklyDigestCron,
    TenantLifecycleEmailsService,
    TenantLifecycleEmailsCron,
    AdminImpersonationAuditService,
    SuperAdminService,
    SuperAdminSessionsService,
    SuperAdminTwoFactorService,
    AdminTenantsService,
    AdminTenantInteractionsService,
    AdminTenantFollowupsService,
    AdminTodayService,
    AdminFinanceService,
    AdminSupportService,
    AdminCommsService,
    AdminMetricsService,
    ImpersonationService,
    SuperAdminAuditService,
    SupportTicketsService,
  ],
  exports: [SuperAdminService, SuperAdminAuditService],
})
export class AdminModule {}
