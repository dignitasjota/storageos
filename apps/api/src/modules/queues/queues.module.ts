import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import type { Env } from '../../config/env.schema';

/**
 * Identificadores de las colas BullMQ usadas por el backend. Las
 * declaramos aqui como constantes para evitar typos al inyectar con
 * `@InjectQueue(QUEUE_X)`.
 */
export const QUEUE_BILLING = 'billing';
export const QUEUE_DUNNING = 'dunning';
export const QUEUE_PAYMENTS = 'payments';
export const QUEUE_VERIFACTU = 'verifactu';
export const QUEUE_EMAIL = 'email';

/**
 * Tipos de job conocidos por cada cola. Compartidos entre producer y
 * worker para garantizar consistencia.
 */
export const JOB_BILLING_GENERATE_RECURRING = 'generate-recurring';
export const JOB_DUNNING_PROCESS_INVOICE = 'process-invoice';
export const JOB_DUNNING_EXECUTE_ACTION = 'execute-action';
export const JOB_PAYMENTS_SYNC = 'sync';
export const JOB_VERIFACTU_SEND = 'send-to-aeat';
export const JOB_EMAIL_SEND = 'send';

/**
 * Modulo global que registra Redis + las colas BullMQ + el scheduler.
 *
 * Fase 4: worker en el mismo proceso NestJS (sin `apps/worker` separado).
 * Cualquier handler `@Processor` registrado en algun modulo se conecta a
 * la misma instancia de Redis y consume los jobs encolados.
 *
 * Fase 8 (futuro): se extrae a `apps/worker` con su propio `main.ts`.
 * Cambio trivial: importar `QueuesModule` desde alli con el `ScheduleModule`
 * apagado en la API.
 */
@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          host: config.get('REDIS_HOST', { infer: true }),
          port: config.get('REDIS_PORT', { infer: true }),
          ...(config.get('REDIS_PASSWORD', { infer: true })
            ? { password: config.get('REDIS_PASSWORD', { infer: true }) }
            : {}),
          db: config.get('REDIS_DB', { infer: true }),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1000, age: 7 * 24 * 60 * 60 },
          removeOnFail: { count: 5000, age: 30 * 24 * 60 * 60 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_BILLING },
      { name: QUEUE_DUNNING },
      { name: QUEUE_PAYMENTS },
      { name: QUEUE_VERIFACTU },
      { name: QUEUE_EMAIL },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
