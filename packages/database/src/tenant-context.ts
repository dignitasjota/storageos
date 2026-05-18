import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Ejecuta `fn` con la variable de sesion `app.current_tenant` establecida.
 *
 * Las politicas RLS del schema (ver `phase1a_rls`) leen ese valor para
 * filtrar el acceso de `storageos_app` a los datos del tenant. El bloque
 * se ejecuta dentro de una transaccion interactiva para garantizar que el
 * `set_config` y todas las queries van por la misma conexion. El tercer
 * argumento `true` de `set_config` marca el valor como local: se descarta
 * automaticamente al commit o rollback de la transaccion, lo que evita
 * fugas entre requests cuando reutilizamos conexiones del pool.
 *
 * Recomendado: todo flujo que conecte como `storageos_app` debe envolverse
 * en `withTenantContext`. Si la conexion es como admin (`storageos`), las
 * politicas RLS se bypassan por owner y la llamada no es necesaria.
 *
 * @example
 *   const users = await withTenantContext(prisma, tenantId, (tx) =>
 *     tx.user.findMany(),
 *   );
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}
