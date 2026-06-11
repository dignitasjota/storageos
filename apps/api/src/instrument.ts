import * as Sentry from '@sentry/nestjs';

/**
 * Inicializacion de Sentry. DEBE importarse como PRIMERA linea de `main.ts`
 * para que la instrumentacion automatica (http, express, prisma via
 * OpenTelemetry) parchee los modulos antes de que nadie los cargue.
 *
 * Lee `process.env` directamente (no `ConfigService`) porque corre antes de
 * que exista el contexto de NestJS. Sin `SENTRY_DSN` es un no-op total:
 * dev/test no necesitan cuenta de Sentry y `captureException` sin init no
 * lanza.
 */
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Solo errores por defecto; subir via env si queremos tracing APM.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0'),
  });
}
