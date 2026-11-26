import { permissionsForRole, type Permission } from '@storageos/shared';

import type { PrismaAdminService } from '../../database/prisma-admin.service';

export interface SeoRecipient {
  id: string;
  name: string;
  email: string;
}

/**
 * Personas del equipo de un tenant con un permiso (activas y con el email
 * verificado): quienes reciben los correos de SEO Avanzado.
 */
export async function tenantUsersWithPermission(
  admin: PrismaAdminService,
  tenantId: string,
  permission: Permission,
): Promise<SeoRecipient[]> {
  const users = await admin.user.findMany({
    where: { tenantId, isActive: true, emailVerifiedAt: { not: null } },
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      tenantRole: { select: { permissions: true } },
    },
    orderBy: { fullName: 'asc' },
  });
  return users
    .filter((u) => {
      const perms =
        u.role !== 'owner' && u.tenantRole
          ? (u.tenantRole.permissions as string[])
          : permissionsForRole(u.role);
      return perms.includes(permission);
    })
    .map((u) => ({ id: u.id, name: u.fullName, email: u.email.toLowerCase() }));
}

/** Super admins activos (los del informe y los avisos de la plataforma). */
export async function activeSuperAdmins(admin: PrismaAdminService): Promise<SeoRecipient[]> {
  const rows = await admin.superAdmin.findMany({
    where: { isActive: true },
    select: { id: true, fullName: true, email: true },
    orderBy: { fullName: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, name: r.fullName, email: r.email.toLowerCase() }));
}
