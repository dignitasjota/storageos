import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Prefijo usado por todos los super admins creados en e2e para limpiar. */
export const SUPER_ADMIN_TEST_PREFIX = 'test-2fa-';

export interface SeededSuperAdmin {
  id: string;
  email: string;
  password: string;
}

/**
 * Crea un super admin via Prisma admin (sin pasar por HTTP). Las
 * llamadas paralelas con el mismo `prefix` no colisionan porque el
 * email se genera con un sufijo unico.
 */
export async function seedSuperAdmin(
  prefix: string,
  password = 'AdminTest!23',
): Promise<SeededSuperAdmin> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${SUPER_ADMIN_TEST_PREFIX}${prefix}-${stamp}@storageos.local`;
    const passwordHash = await argonHash(password);
    const created = await admin.superAdmin.create({
      data: {
        email,
        passwordHash,
        fullName: `Test ${prefix}`,
        role: 'superadmin',
      },
    });
    return { id: created.id, email: created.email, password };
  } finally {
    await admin.$disconnect();
  }
}

/** Borra todos los super admins creados durante e2e (prefix `test-2fa-`). */
export async function cleanupSuperAdmins(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    // Borrar dependencias primero (FK Restrict).
    const targets = await admin.superAdmin.findMany({
      where: { email: { startsWith: SUPER_ADMIN_TEST_PREFIX } },
      select: { id: true },
    });
    if (targets.length === 0) return;
    const ids = targets.map((t) => t.id);
    await admin.$transaction([
      admin.superAdminRecoveryCode.deleteMany({ where: { superAdminId: { in: ids } } }),
      admin.superAdminSession.deleteMany({ where: { superAdminId: { in: ids } } }),
      admin.superAdmin.deleteMany({ where: { id: { in: ids } } }),
    ]);
  } finally {
    await admin.$disconnect();
  }
}

/**
 * Extrae el valor de la cookie `super_admin_refresh` de los headers
 * `set-cookie` de una respuesta Supertest. Devuelve el string completo
 * (`name=value; Path=/admin; HttpOnly; ...`) para reenviarlo como `Cookie`
 * en peticiones posteriores.
 */
export function extractSuperAdminRefreshCookie(headers: Record<string, unknown>): string | null {
  const raw = headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === 'string'
      ? [raw]
      : [];
  return cookies.find((c) => c.startsWith('super_admin_refresh=')) ?? null;
}
