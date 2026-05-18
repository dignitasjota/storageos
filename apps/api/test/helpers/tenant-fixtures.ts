import { PrismaClient } from '@storageos/database';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Borra todos los tenants cuyo `slug` empiece por `test-`. Util para
 * dejar la BD limpia antes/despues de una suite. Como las FKs son
 * Restrict, tenemos que ir tabla por tabla en el orden inverso a las
 * dependencias.
 */
export async function cleanupTestTenants(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    const testTenants = await admin.tenant.findMany({
      where: { slug: { startsWith: 'test-' } },
      select: { id: true },
    });
    const ids = testTenants.map((t) => t.id);
    if (ids.length === 0) return;

    await admin.$transaction([
      admin.session.deleteMany({ where: { tenantId: { in: ids } } }),
      admin.auditLog.deleteMany({ where: { tenantId: { in: ids } } }),
      admin.tenantSubscription.deleteMany({ where: { tenantId: { in: ids } } }),
      admin.user.deleteMany({ where: { tenantId: { in: ids } } }),
      admin.tenant.deleteMany({ where: { id: { in: ids } } }),
    ]);
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Devuelve un slug y email unicos por test, evitando colisiones entre
 * ejecuciones rapidas y entre tests dentro de la misma suite.
 */
export function uniqueTestIds(prefix: string): { slug: string; email: string } {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    slug: `test-${prefix}-${stamp}`,
    email: `${prefix}-${stamp}@e2e.local`,
  };
}
