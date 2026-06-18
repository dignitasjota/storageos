import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';

import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { legacyRedirectHandler } from '../../src/common/middleware/legacy-redirect.middleware';

import type { INestApplication } from '@nestjs/common';
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

  const app = moduleRef.createNestApplication({ bufferLogs: true });
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
  await app.init();
  return app;
}
