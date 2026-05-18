/**
 * @storageos/database — cliente Prisma + helpers para multi-tenant.
 *
 * Las apps importan desde aqui:
 *   import { createPrismaClient, withTenantContext, type Tenant } from '@storageos/database';
 *
 * Para que los tipos generados esten disponibles hay que correr
 * `pnpm db:generate` (lo encadena `turbo` cuando otro paquete lo necesita).
 */
export * from '@prisma/client';
export { createPrismaClient } from './prisma-client';
export type { CreatePrismaClientOptions } from './prisma-client';
export { withTenantContext } from './tenant-context';
