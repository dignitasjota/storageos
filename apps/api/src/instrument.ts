import * as Sentry from '@sentry/nestjs';

import { sanitizeHeaders, sanitizeUrl, REDACTED } from './common/logging/sanitize';

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
    // La instrumentación http adjunta url/query/cabeceras de la request al
    // evento: mismo saneado que los logs (device key/PIN, tokens en la ruta).
    beforeSend(event) {
      if (event.request) {
        if (event.request.url) event.request.url = sanitizeUrl(event.request.url) ?? REDACTED;
        if (event.request.query_string) event.request.query_string = REDACTED;
        if (event.request.headers) {
          event.request.headers = sanitizeHeaders(event.request.headers) as Record<string, string>;
        }
      }
      return event;
    },
  });
}
