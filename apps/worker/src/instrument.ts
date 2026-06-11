import * as Sentry from '@sentry/nestjs';

/**
 * Inicializacion de Sentry para el worker. Misma logica que
 * `apps/api/src/instrument.ts`: lee `process.env` directamente y sin
 * `SENTRY_DSN` es un no-op total. Las default integrations capturan
 * unhandled rejections / uncaught exceptions, que es donde mueren los
 * errores de los processors BullMQ que escapan a sus try/catch.
 */
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
  });
}
