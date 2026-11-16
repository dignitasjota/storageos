import * as Sentry from '@sentry/nestjs';

import { REDACTED, sanitizeUrl } from '../../api/src/common/logging/sanitize';

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
    // El worker es quien llama cada día a Google y Meta: sus direcciones
    // quedan en las migas, sin los tokens.
    beforeBreadcrumb(breadcrumb) {
      const data = breadcrumb.data as Record<string, unknown> | undefined;
      if (data) {
        if (typeof data.url === 'string') data.url = sanitizeUrl(data.url) ?? REDACTED;
        if ('http.query' in data) data['http.query'] = REDACTED;
      }
      return breadcrumb;
    },
  });
}
