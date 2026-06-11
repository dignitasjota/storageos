import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';

import {
  QUEUE_AUTOMATIONS,
  QUEUE_BILLING,
  QUEUE_COMMUNICATIONS,
  QUEUE_DUNNING,
  QUEUE_REPORTS,
  QUEUE_VERIFACTU,
} from '../../api/src/modules/queues/queues.module';
import { WorkerModule } from '../src/worker.module';

import type { INestApplicationContext } from '@nestjs/common';

/**
 * Suite minima: verifica que el grafo DI del worker se cierra (todos los
 * providers se resuelven sin dependencias rotas) y que las colas BullMQ
 * estan registradas. No abrimos conexiones reales contra Postgres/Redis
 * porque `BullModule.registerQueue` registra los providers con la
 * configuracion declarativa antes de hacer connect; ademas `ioredis` esta
 * redirigido a `ioredis-mock` via `moduleNameMapper` en `jest.config.js`.
 *
 * El init de BullMQ se hace lazy en `onModuleInit`, por lo que el test se
 * cierra rapido (`compile()` sin `init()`).
 *
 * Nota (15A follow-up): el grafo DI requeria `FilesModule` (provider global
 * `FilesService` que `InvoicePdfService` inyecta en `BillingModule`). En el
 * API lo aporta `AppModule` por ser `@Global()`; el worker no lo importaba,
 * asi que el contexto de Test no lo resolvia. Anadido a `WorkerModule` y la
 * suite pasa a verde.
 */
describe('Worker bootstrap', () => {
  // Variables minimas para que `envSchema` no falle en validate().
  const ORIGINAL_ENV = process.env;

  beforeAll(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      DATABASE_ADMIN_URL: 'postgresql://admin:pass@localhost:5432/db',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_2FA_PENDING_SECRET: 'b'.repeat(32),
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      MINIO_ACCESS_KEY: 'minio',
      MINIO_SECRET_KEY: 'minio12345',
      LOG_PRETTY: 'false',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  let context: INestApplicationContext | null = null;

  afterEach(async () => {
    if (context) {
      await context.close();
      context = null;
    }
  });

  it('compiles the DI graph without errors', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    context = moduleRef;
    expect(moduleRef).toBeDefined();
  });

  it('registers every BullMQ queue consumed by the worker', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    context = moduleRef;

    const queueNames = [
      QUEUE_BILLING,
      QUEUE_VERIFACTU,
      QUEUE_DUNNING,
      QUEUE_COMMUNICATIONS,
      QUEUE_AUTOMATIONS,
      QUEUE_REPORTS,
    ];

    for (const name of queueNames) {
      const queue = moduleRef.get(getQueueToken(name), { strict: false });
      expect(queue).toBeDefined();
    }
  });
});
