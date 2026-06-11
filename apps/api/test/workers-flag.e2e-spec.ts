import { getQueueToken } from '@nestjs/bullmq';

import { JOB_VERIFACTU_SEND, QUEUE_VERIFACTU } from '../src/modules/queues/queues.module';

import type { INestApplicationContext, Type } from '@nestjs/common';
import type { Queue } from 'bullmq';

/**
 * Sub-bloque 14A.1 — flag `ENABLE_WORKERS_IN_API`.
 *
 * Verifica:
 *
 *   1. Con `ENABLE_WORKERS_IN_API=true` (default): el `VerifactuProcessor`
 *      esta registrado en el contenedor DI (se puede `get()` sin error).
 *   2. Con `ENABLE_WORKERS_IN_API=false`: el `VerifactuProcessor` NO esta
 *      registrado (`get()` lanza). El `BillingJobsService` SI sigue
 *      registrado porque el controller HTTP lo necesita.
 *   3. Con `ENABLE_WORKERS_IN_API=false`: las queues BullMQ siguen
 *      registradas, por lo que el API puede ENCOLAR jobs aunque no los
 *      procese (el worker separado se encarga).
 *
 * Implementacion: cargamos el `AppModule` completo en un sub-contexto
 * NestJS aislado via `jest.isolateModulesAsync`. La constante top-level
 * `WORKERS_ENABLED_IN_API` (en `config/workers-enabled.ts`) se reevalua
 * dentro de cada bloque aislado tras fijar `process.env`.
 *
 * Nota: no inicializamos HTTP server porque solo necesitamos resolver
 * providers — usamos `createApplicationContext` indirectamente via
 * `Test.compile()` que NO arranca listeners. BullMQ conecta a Redis
 * lazy en `onModuleInit` (que `compile()` no dispara), asi que no
 * necesitamos Redis arriba.
 *
 * IMPORTANTE: `Test` (de `@nestjs/testing`) se importa DENTRO del bloque
 * aislado, no a nivel top. `jest.isolateModulesAsync` carga copias frescas
 * de `@nestjs/core` y `@nestjs/event-emitter` para reevaluar el flag; si el
 * `Test` proviniese del registro externo, su `@nestjs/core` y el del
 * `AppModule` aislado serian instancias distintas y el `EventSubscribersLoader`
 * de la copia aislada pediria un `ModuleRef` que el injector externo no
 * reconoce ("Nest can't resolve dependencies of the EventSubscribersLoader").
 * Importandolo dentro, todo comparte el mismo registro de modulos.
 */
describe('Workers flag (ENABLE_WORKERS_IN_API)', () => {
  const ORIGINAL_FLAG = process.env.ENABLE_WORKERS_IN_API;

  afterEach(() => {
    // Restaurar el flag para no contaminar otras suites del runInBand.
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.ENABLE_WORKERS_IN_API;
    } else {
      process.env.ENABLE_WORKERS_IN_API = ORIGINAL_FLAG;
    }
  });

  /**
   * Carga el `AppModule` en un sub-contexto NestJS aislado, evaluando
   * los imports DESPUES de fijar el flag, y devuelve el contexto + las
   * clases dinamicas necesarias para inspeccion.
   */
  async function bootstrapAppWithFlag(flag: 'true' | 'false'): Promise<{
    context: INestApplicationContext;
    VerifactuProcessor: Type<unknown>;
    BillingJobsService: Type<unknown>;
    BillingRecurringProcessor: Type<unknown>;
  }> {
    process.env.ENABLE_WORKERS_IN_API = flag;

    let context!: INestApplicationContext;
    let VerifactuProcessor!: Type<unknown>;
    let BillingJobsService!: Type<unknown>;
    let BillingRecurringProcessor!: Type<unknown>;

    await jest.isolateModulesAsync(async () => {
      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../src/app.module');
      const verifactuMod = await import('../src/modules/billing/verifactu.processor');
      const billingJobsMod = await import('../src/modules/billing/billing-jobs.service');
      const billingRecurringMod =
        await import('../src/modules/billing/billing-recurring.processor');
      VerifactuProcessor = verifactuMod.VerifactuProcessor as unknown as Type<unknown>;
      BillingJobsService = billingJobsMod.BillingJobsService as unknown as Type<unknown>;
      BillingRecurringProcessor =
        billingRecurringMod.BillingRecurringProcessor as unknown as Type<unknown>;

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      context = moduleRef;
    });

    return { context, VerifactuProcessor, BillingJobsService, BillingRecurringProcessor };
  }

  it('con ENABLE_WORKERS_IN_API=true, VerifactuProcessor esta registrado', async () => {
    const { context, VerifactuProcessor } = await bootstrapAppWithFlag('true');
    try {
      const processor = context.get(VerifactuProcessor, { strict: false });
      expect(processor).toBeDefined();
      expect(processor).toBeInstanceOf(VerifactuProcessor);
    } finally {
      await context.close();
    }
  });

  it('con ENABLE_WORKERS_IN_API=false, los Processors NO estan registrados pero BillingJobsService SI', async () => {
    const { context, VerifactuProcessor, BillingJobsService, BillingRecurringProcessor } =
      await bootstrapAppWithFlag('false');
    try {
      // Los Processors no deben poder resolverse.
      expect(() => context.get(VerifactuProcessor, { strict: false })).toThrow();
      expect(() => context.get(BillingRecurringProcessor, { strict: false })).toThrow();
      // El service base SI debe poder resolverse — el controller HTTP lo necesita.
      const service = context.get(BillingJobsService, { strict: false });
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(BillingJobsService);
    } finally {
      await context.close();
    }
  });

  it('con ENABLE_WORKERS_IN_API=false, la cola verifactu sigue registrada y permite encolar', async () => {
    const { context } = await bootstrapAppWithFlag('false');
    try {
      const queue = context.get<Queue>(getQueueToken(QUEUE_VERIFACTU), { strict: false });
      expect(queue).toBeDefined();
      expect(typeof queue.add).toBe('function');
      // El nombre del job que el API encolaria desde InvoicesService.issue
      // cuando se emite una factura. Que la constante exista y la cola
      // tenga `add` confirma que el flow producer sigue operativo.
      expect(JOB_VERIFACTU_SEND).toBe('send-to-aeat');
    } finally {
      await context.close();
    }
  });
});
