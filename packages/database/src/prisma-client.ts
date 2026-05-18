import { type Prisma, PrismaClient } from '@prisma/client';

export interface CreatePrismaClientOptions {
  /** Sobrescribe el `DATABASE_URL` del schema. Útil para tests o conexiones admin. */
  databaseUrl?: string;
  /** Niveles de log; por defecto `['error', 'warn']`. */
  log?: Prisma.LogLevel[];
}

/**
 * Crea un nuevo `PrismaClient`. No se cachea: el consumidor (NestJS module,
 * test, script) decide el ciclo de vida y llama a `$disconnect` al terminar.
 */
export function createPrismaClient(opts: CreatePrismaClientOptions = {}): PrismaClient {
  const datasources = opts.databaseUrl ? { db: { url: opts.databaseUrl } } : undefined;

  return new PrismaClient({
    ...(datasources ? { datasources } : {}),
    log: opts.log ?? ['error', 'warn'],
  });
}
