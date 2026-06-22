import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';

import { AsyncContextModule } from '../../api/src/common/async-context/async-context.module';
import { CryptoModule } from '../../api/src/common/crypto/crypto.module';
import { AppConfigModule } from '../../api/src/config/env.config';
import { AccessModule } from '../../api/src/modules/access/access.module';
import { AuthModule } from '../../api/src/modules/auth/auth.module';
import { AutomationsModule } from '../../api/src/modules/automations/automations.module';
import { BillingModule } from '../../api/src/modules/billing/billing.module';
import { CommunicationsModule } from '../../api/src/modules/communications/communications.module';
import { ContractsModule } from '../../api/src/modules/contracts/contracts.module';
import { DatabaseModule } from '../../api/src/modules/database/database.module';
import { DunningModule } from '../../api/src/modules/dunning/dunning.module';
import { EmailModule } from '../../api/src/modules/email/email.module';
import { FilesModule } from '../../api/src/modules/files/files.module';
import { IntegrationsModule } from '../../api/src/modules/integrations/integrations.module';
import { NotificationsModule } from '../../api/src/modules/notifications/notifications.module';
import { PaymentsModule } from '../../api/src/modules/payments/payments.module';
import { PushModule } from '../../api/src/modules/push/push.module';
import { QueuesModule } from '../../api/src/modules/queues/queues.module';
import { RentIncreasesModule } from '../../api/src/modules/rent-increases/rent-increases.module';
import { ReportsModule } from '../../api/src/modules/reports/reports.module';
import { ReviewsModule } from '../../api/src/modules/reviews/reviews.module';
import { SecurityEventsModule } from '../../api/src/modules/security-events/security-events.module';

import type { Env } from '../../api/src/config/env.schema';
import type { Options as PinoHttpOptions } from 'pino-http';

/**
 * Modulo raiz del worker.
 *
 * Reutiliza los mismos modulos del API que contienen `@Processor` BullMQ y
 * crons (`@Cron` de @nestjs/schedule). Como arrancamos con
 * `createApplicationContext` no se levanta HTTP server, por lo que los
 * controllers se registran pero NO son alcanzables (no hay router).
 *
 * Importamos los modulos por path relativo (no via paths alias `@api/*`)
 * porque tsc NO reescribe los alias en el output, y Node no entiende los
 * paths del tsconfig en runtime. Manteniendo los imports relativos, el
 * codigo compilado a `dist/` es directamente ejecutable sin loaders.
 *
 * Modulos de infraestructura necesarios para cerrar el grafo DI:
 * - `AppConfigModule`        -> ConfigService global con validacion Zod.
 * - `LoggerModule`           -> pino global.
 * - `EventEmitterModule`     -> domain events in-process.
 * - `AsyncContextModule`     -> tenant context (RLS).
 * - `CryptoModule`           -> usado por billing, access, auth.
 * - `DatabaseModule`         -> PrismaService + PrismaAdminService.
 * - `SecurityEventsModule`   -> SecurityEventsService global.
 * - `EmailModule`            -> EmailService global.
 * - `AuthModule`             -> AuthService usado por servicios reusados.
 * - `PaymentsModule`         -> dependencia de BillingModule.
 * - `QueuesModule`           -> conexion Redis + colas BullMQ.
 *
 * Modulos con `@Processor` / `@Cron` que ejecuta el worker:
 * - `BillingModule`          -> VerifactuProcessor + BillingRecurringProcessor (cron + processor).
 * - `CommunicationsModule`   -> CommunicationsProcessor.
 * - `AutomationsModule`      -> AutomationsProcessor + listeners.
 * - `ReportsModule`          -> ReportsProcessor.
 * - `DunningModule`          -> DunningProcessor (cron diario + handler de jobs).
 * - `AccessModule`           -> dependencia de DunningModule.
 * - `SecurityEventsModule`   -> SecurityAlertsCron + SecurityEventsCleanupService.
 *
 * Sub-bloque 14A.1: estos Processors y Crons ya NO se registran en el
 * API en produccion (`ENABLE_WORKERS_IN_API=false` en `.env.prod`). El
 * worker fuerza el flag a `'true'` en `main.ts` antes de cualquier
 * import para garantizar que SIEMPRE los registre, independientemente
 * del `.env.prod` compartido con el API.
 */
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
            paths: ['*.password', '*.passwordHash', '*.refreshToken'],
            censor: '[REDACTED]',
          },
          ...(pretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname',
                  },
                },
              }
            : {}),
        };
        return { pinoHttp };
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
    FilesModule,
    SecurityEventsModule,
    EmailModule,
    QueuesModule,
    AuthModule,
    PaymentsModule,
    BillingModule,
    CommunicationsModule,
    AutomationsModule,
    ReportsModule,
    DunningModule,
    AccessModule,
    IntegrationsModule,
    // CRM: cron `contract_ending_soon` + feed de notificaciones in-app +
    // cron `reviews.auto-request`.
    ContractsModule,
    NotificationsModule,
    ReviewsModule,
    RentIncreasesModule,
    // PushModule: listener invoice_overdue (dunning corre aquí en prod) → push.
    PushModule,
  ],
})
export class WorkerModule {}
