import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import {
  QUEUE_AUTOMATIONS,
  QUEUE_BILLING,
  QUEUE_COMMUNICATIONS,
  QUEUE_DUNNING,
  QUEUE_EMAIL,
  QUEUE_PAYMENTS,
  QUEUE_REPORTS,
  QUEUE_VERIFACTU,
  QUEUE_WEBHOOKS,
} from './queue-names';
import { RedisMemoryCron } from './redis-memory.cron';
import { WorkersHeartbeatCron } from './workers-heartbeat.cron';

import type { Env } from '../../config/env.schema';

/**
 * Identificadores de las colas BullMQ. Viven en `queue-names.ts` (sin
 * imports) para que los providers registrados en este modulo puedan
 * usarlos sin ciclo; se re-exportan aqui para el resto del codigo.
 */
export {
  QUEUE_AUTOMATIONS,
  QUEUE_BILLING,
  QUEUE_COMMUNICATIONS,
  QUEUE_DUNNING,
  QUEUE_EMAIL,
  QUEUE_PAYMENTS,
  QUEUE_REPORTS,
  QUEUE_VERIFACTU,
  QUEUE_WEBHOOKS,
} from './queue-names';

/**
 * Tipos de job conocidos por cada cola. Compartidos entre producer y
 * worker para garantizar consistencia.
 */
export const JOB_BILLING_GENERATE_RECURRING = 'generate-recurring';
export const JOB_DUNNING_PROCESS_INVOICE = 'process-invoice';
export const JOB_DUNNING_EXECUTE_ACTION = 'execute-action';
export const JOB_PAYMENTS_SYNC = 'sync';
export const JOB_PAYMENTS_AUTO_CHARGE = 'auto-charge';
export const JOB_VERIFACTU_SEND = 'send-to-aeat';
export const JOB_EMAIL_SEND = 'send';
export const JOB_COMMUNICATIONS_DISPATCH = 'dispatch';
export const JOB_AUTOMATIONS_RUN = 'run';
export const JOB_REPORTS_GENERATE = 'generate';
export const JOB_WEBHOOK_DELIVER = 'deliver';

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
      { name: QUEUE_COMMUNICATIONS },
      { name: QUEUE_AUTOMATIONS },
      { name: QUEUE_REPORTS },
      { name: QUEUE_WEBHOOKS },
    ),
  ],
  // Heartbeat de los workers: lo escribe el proceso que los ejecuta (el
  // worker en prod, el API en dev/test). QueuesModule esta en el grafo DI
  // de AMBOS procesos, por eso vive aqui y no en HealthModule (HTTP-only).
  providers: [...(WORKERS_ENABLED_IN_API ? [WorkersHeartbeatCron, RedisMemoryCron] : [])],
  exports: [BullModule],
})
export class QueuesModule {}
