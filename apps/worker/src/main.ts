// IMPORTANTE Sub-bloque 14A.1: forzamos `ENABLE_WORKERS_IN_API='true'`
// ANTES de cualquier import. `apps/worker` reusa los modulos del API
// (que comparten `.env.prod` con `ENABLE_WORKERS_IN_API=false` para el
// proceso `api`), pero el worker siempre debe registrar los Processors
// y los Crons. La constante `WORKERS_ENABLED_IN_API` se evalua en el
// momento de cargar `config/workers-enabled.ts` mediante el primer
// import, asi que este override DEBE ir en primera linea.
process.env.ENABLE_WORKERS_IN_API = 'true';

// Sentry: tras el override de env (es solo lectura de process.env) y antes
// de cargar cualquier modulo, para que la instrumentacion parchee primero.
import './instrument';

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { WorkerModule } from './worker.module';

/**
 * Entry point del worker TrasterOS.
 *
 * Arranca un NestJS application context (sin HTTP server) que carga los
 * modulos con `@Processor` BullMQ y `@Cron`. Los controllers que arrastren
 * los modulos importados se registran en el contenedor DI pero, al no
 * existir router HTTP, nunca son invocados.
 *
 * Manejo de senales:
 * - `SIGTERM` y `SIGINT` cierran el contexto NestJS de forma ordenada
 *   (`app.close()`), lo que detiene los workers BullMQ esperando a que
 *   terminen los jobs en curso. Necesario para deploys con downtime cero.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const logger = app.get(Logger);
  logger.log('TrasterOS worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`${signal} received, shutting down worker`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

bootstrap().catch((err) => {
  // Si fallamos antes de tener logger configurado, vamos a stderr.

  console.error('Failed to start worker', err);
  process.exit(1);
});
