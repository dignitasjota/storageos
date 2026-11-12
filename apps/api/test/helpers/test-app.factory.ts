import { WorkerHost } from '@nestjs/bullmq';
import { VersioningType } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { json, raw } from 'express';

import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { configureTrustProxy } from '../../src/common/http/trust-proxy';
import { legacyRedirectHandler } from '../../src/common/middleware/legacy-redirect.middleware';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Worker } from 'bullmq';
import type { NextFunction, Request, Response } from 'express';

export interface CreateTestAppOptions {
  /**
   * Si `true` (default), inserta un middleware temprano que reescribe
   * in-place las URLs legacy (sin prefijo `/v1/`) sumando `/v1` antes
   * de que llegue al router. Asi las ~30 suites e2e existentes — que
   * apuntan a `/auth/login`, `/contracts`, etc. — siguen verdes sin
   * tener que reescribir cada path.
   *
   * Si `false`, no se rewrite y el `LegacyRedirectMiddleware` real
   * responde con 308. Usalo solo en specs que verifican el redirect.
   */
  rewriteLegacyToV1?: boolean;
}

/**
 * Arranca una instancia del AppModule lista para Supertest. Aplica
 * cookie-parser, el filtro global de excepciones y el versioning URI
 * (`/v1/...`), igual que `main.ts`. Helmet y CORS no se aplican (no
 * afectan al body de respuesta).
 *
 * Particularidad de tests: por defecto se inserta un rewrite in-place
 * de URLs legacy a `/v1/...` (ver `CreateTestAppOptions.rewriteLegacyToV1`),
 * equivalente al 308 que sirve `LegacyRedirectMiddleware` en produccion,
 * para evitar que supertest tenga que seguir un redirect (su default
 * es `redirects(0)`).
 *
 * El rate limiting se omite en tests porque todos los requests vienen
 * desde 127.0.0.1 y comparten bucket: el `ThrottlerModule` lo detecta
 * via `NODE_ENV=test` y aplica `skipIf: () => true`. El throttle real
 * se valida con smoke tests cURL (ver docs/API.md).
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<INestApplication> {
  const { rewriteLegacyToV1 = true } = options;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  // Igual que prod (1 proxy delante): la IP del cliente sale de X-Forwarded-For.
  configureTrustProxy(app, 1);
  // Webhooks firmados sobre el raw body (deben ir antes del parser JSON).
  // Un correo entrante trae sus adjuntos dentro. Va envuelto porque, si Nest ve
  // un `jsonParser` ya puesto, no añade el suyo para el resto de rutas.
  const inboundJson = json({ limit: '30mb' });
  app.use('/webhooks/email-inbound', (req: Request, res: Response, next: NextFunction) =>
    inboundJson(req, res, next),
  );
  app.use('/webhooks/stripe', raw({ type: 'application/json' }));
  app.use('/webhooks/stripe-connect', raw({ type: 'application/json' }));
  app.use('/webhooks/gocardless', raw({ type: 'application/json' }));
  app.use('/webhooks/email-events/resend', raw({ type: () => true }));
  // Redsys postea urlencoded (los tests, JSON): raw para ambos y el
  // controller parsea estricto (defensa en profundidad, auditoría 2026-07).
  app.use('/webhooks/redsys', raw({ type: () => true }));
  // WhatsApp inbound (Meta): raw para verificar la firma X-Hub-Signature-256.
  app.use('/webhooks/whatsapp', raw({ type: () => true }));
  app.use(cookieParser());

  if (rewriteLegacyToV1) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const url = req.url;
      const isExempt =
        url.startsWith('/v1/') ||
        url === '/v1' ||
        url === '/health' ||
        url.startsWith('/health?') ||
        url.startsWith('/health/') ||
        url.startsWith('/api/docs') ||
        url.startsWith('/webhooks/') ||
        url.startsWith('/public/widget/') ||
        url.startsWith('/public/landing/') ||
        url.startsWith('/public/marketing/go/') ||
        url === '/' ||
        url === '/favicon.ico';
      if (!isExempt) {
        req.url = `/v1${url}`;
      }
      next();
    });
  } else {
    // Sin rewrite, registramos el redirect 308 real (igual que main.ts).
    app.use(legacyRedirectHandler);
  }

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  // Un solo puerto en `127.0.0.1` para toda la suite. Sin esto, supertest abre uno
  // al azar en cada petición y, si coincide con el de otro programa del equipo, la
  // petición le llega a él (`404 {}` o se queda esperando).
  await app.listen(0, '127.0.0.1');
  closeQueuesQuickly(app);
  return app;
}

/** Lo que se espera, como mucho, a los trabajos que esta app tiene en marcha al cerrarla. */
const QUEUE_CLOSE_WAIT_MS = 10_000;

/**
 * Al cerrar la app, las colas no esperan a lo que no es suyo. Por defecto cada
 * trabajador espera a que vuelva su espera de trabajos (hasta 10 s si hay alguno
 * programado para después, como los envíos de Veri*Factu) y la prueba miraba los
 * trabajos «activos» de la cola, que pueden ser restos de otra suite: en la CI,
 * más lenta, el cierre pasaba de los 30 s de Jest. Se espera solo a los trabajos
 * que esta app está haciendo y después se cierran las colas sin esperar.
 */
function closeQueuesQuickly(app: INestApplication): void {
  const workers = app
    .get(DiscoveryService, { strict: false })
    .getProviders()
    .map((wrapper) => wrapper.instance as unknown)
    .filter((instance): instance is WorkerHost => instance instanceof WorkerHost)
    .map((host) => host.worker as Worker | undefined)
    .filter((worker): worker is Worker => !!worker);
  const running = new Map<Worker, number>(workers.map((w) => [w, 0]));
  for (const worker of workers) {
    const done = () => running.set(worker, Math.max(0, (running.get(worker) ?? 1) - 1));
    worker.on('active', () => running.set(worker, (running.get(worker) ?? 0) + 1));
    worker.on('completed', done);
    worker.on('failed', done);
  }
  const close = app.close.bind(app);
  app.close = async () => {
    const until = Date.now() + QUEUE_CLOSE_WAIT_MS;
    const busy = () => workers.filter((w) => (running.get(w) ?? 0) > 0);
    while (busy().length > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const stuck = busy();
    if (stuck.length > 0) {
      console.warn(
        `[e2e] colas con trabajos en marcha a los ${QUEUE_CLOSE_WAIT_MS / 1000} s, se cierran sin esperarlos: ${stuck.map((w) => w.name).join(', ')}`,
      );
    }
    await Promise.all(workers.map((w) => w.close(true).catch(() => undefined)));
    await close();
  };
}
