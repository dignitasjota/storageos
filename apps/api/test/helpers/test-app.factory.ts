import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';

import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

import type { INestApplication } from '@nestjs/common';

/**
 * Arranca una instancia del AppModule lista para Supertest. Aplica
 * cookie-parser y el filtro global de excepciones, igual que `main.ts`.
 * Helmet y CORS no se aplican (no afectan al body de respuesta).
 *
 * El rate limiting se omite en tests porque todos los requests vienen
 * desde 127.0.0.1 y comparten bucket: el `ThrottlerModule` lo detecta
 * via `NODE_ENV=test` y aplica `skipIf: () => true`. El throttle real
 * se valida con smoke tests cURL (ver docs/API.md).
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}
