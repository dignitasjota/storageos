import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import { AsyncContextModule } from './common/async-context/async-context.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { SecurityThrottlerGuard } from './common/guards/security-throttler.guard';
import { AppConfigModule } from './config/env.config';
import { AccessModule } from './modules/access/access.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { AdminModule } from './modules/admin/admin.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { AutomationsModule } from './modules/automations/automations.module';
import { BillingModule } from './modules/billing/billing.module';
import { BillingSaasModule } from './modules/billing-saas/billing-saas.module';
import { CommunicationsModule } from './modules/communications/communications.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DatabaseModule } from './modules/database/database.module';
import { DunningModule } from './modules/dunning/dunning.module';
import { EmailModule } from './modules/email/email.module';
import { FacilitiesModule } from './modules/facilities/facilities.module';
import { FilesModule } from './modules/files/files.module';
import { HealthModule } from './modules/health/health.module';
import { ImportsModule } from './modules/imports/imports.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MoveInModule } from './modules/move-in/move-in.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PortalModule } from './modules/portal/portal.module';
import { ProductsModule } from './modules/products/products.module';
import { QueuesModule } from './modules/queues/queues.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RgpdModule } from './modules/rgpd/rgpd.module';
import { SecurityEventsModule } from './modules/security-events/security-events.module';
import { TwoFactorModule } from './modules/two-factor/two-factor.module';
import { UsersModule } from './modules/users/users.module';
import { WidgetModule } from './modules/widget/widget.module';

import type { Env } from './config/env.schema';
import type { Options as PinoHttpOptions } from 'pino-http';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const pretty = config.get('LOG_PRETTY', { infer: true });
        const pinoHttp: PinoHttpOptions = {
          level: config.get('LOG_LEVEL', { infer: true }),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.passwordHash',
              '*.refreshToken',
            ],
            censor: '[REDACTED]',
          },
          ...(pretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req.headers,res.headers',
                  },
                },
              }
            : {}),
        };
        return { pinoHttp };
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const isTest = config.get('NODE_ENV', { infer: true }) === 'test';
        return {
          throttlers: [
            // Un solo throttler "default" a nivel global; los endpoints de
            // auth sobreescriben sus limits con
            // @ThrottleLogin / @ThrottleRegister / @ThrottleRefresh.
            { name: 'default', ttl: 60_000, limit: 60 },
          ],
          // En tests todos los requests vienen de 127.0.0.1 y comparten
          // bucket. Deshabilitamos el rate limit para no romper specs; el
          // throttle real se valida con smoke tests cURL (ver docs/API.md).
          ...(isTest ? { skipIf: () => true } : {}),
          errorMessage: 'Demasiadas peticiones, prueba mas tarde.',
        };
      },
    }),
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),
    AsyncContextModule,
    CryptoModule,
    DatabaseModule,
    SecurityEventsModule,
    EmailModule,
    HealthModule,
    AuthModule,
    UsersModule,
    InvitationsModule,
    TwoFactorModule,
    FilesModule,
    FacilitiesModule,
    CustomersModule,
    ContractsModule,
    QueuesModule,
    PaymentsModule,
    BillingModule,
    DunningModule,
    RgpdModule,
    PortalModule,
    CommunicationsModule,
    AutomationsModule,
    LeadsModule,
    WidgetModule,
    OperationsModule,
    ProductsModule,
    AnalyticsModule,
    ReportsModule,
    AccessModule,
    AdminModule,
    BillingSaasModule,
    IntegrationsModule,
    ImportsModule,
    MoveInModule,
    AccountingModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Orden importante: throttler -> jwt -> roles. Cada uno se ejecuta
    // solo si el anterior dejo pasar el request.
    { provide: APP_GUARD, useClass: SecurityThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
/**
 * El `LegacyRedirectMiddleware` se aplica via `app.use()` en `main.ts`
 * (y en `test-app.factory.ts`) antes de `enableVersioning(URI)` porque
 * NestJS aplica `consumer.apply().forRoutes('*')` DESPUÉS del router
 * cuando hay versioning activo, lo que hace que las rutas sin prefijo
 * devuelvan 404 antes de poder redirigir.
 */
export class AppModule {}
