import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../auth/auth.module';
import { TwoFactorModule } from '../two-factor/two-factor.module';

import { AdminMetricsController } from './admin-metrics.controller';
import { AdminMetricsService } from './admin-metrics.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminGuard } from './admin.guard';
import { ImpersonationService } from './impersonation.service';
import { SecurityEventsController } from './security-events.controller';
import { SuperAdminAuthController } from './super-admin-auth.controller';
import { SuperAdminSessionsService } from './super-admin-sessions.service';
import { SuperAdminTwoFactorService } from './super-admin-two-factor.service';
import { SuperAdminService } from './super-admin.service';
import { SupportTicketsAdminController } from './support-tickets-admin.controller';
import { SupportTicketsTenantController } from './support-tickets-tenant.controller';
import { SupportTicketsService } from './support-tickets.service';

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
  imports: [AuthModule, TwoFactorModule, JwtModule.register({})],
  controllers: [
    SuperAdminAuthController,
    AdminTenantsController,
    AdminMetricsController,
    SecurityEventsController,
    SupportTicketsAdminController,
    SupportTicketsTenantController,
  ],
  providers: [
    AdminGuard,
    SuperAdminService,
    SuperAdminSessionsService,
    SuperAdminTwoFactorService,
    AdminTenantsService,
    AdminMetricsService,
    ImpersonationService,
    SupportTicketsService,
  ],
  exports: [SuperAdminService],
})
export class AdminModule {}
