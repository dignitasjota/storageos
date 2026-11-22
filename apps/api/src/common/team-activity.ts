import type { PrismaAdminService } from '../modules/database/prisma-admin.service';

/**
 * Último uso real del panel por el equipo de cada tenant: el más reciente
 * entre el inicio de sesión (`users.last_login_at`) y el último uso de una
 * sesión (`sessions.last_used_at`, que se renueva al refrescar el token) de
 * sus usuarios activos.
 *
 * Solo con `last_login_at` un equipo que entra a diario con la sesión abierta
 * (la app instalada dura 90 días) aparecía como «sin entrar» semanas.
 *
 * Sin `tenantIds` mira todos los tenants. Los que no tienen ninguna señal no
 * aparecen en el mapa (= nunca han entrado).
 */
export async function lastTeamActivityByTenant(
  admin: PrismaAdminService,
  tenantIds?: string[],
): Promise<Map<string, Date>> {
  if (tenantIds && tenantIds.length === 0) return new Map();
  const scope = tenantIds ? { tenantId: { in: tenantIds } } : {};
  const [logins, sessions] = await Promise.all([
    admin.user.groupBy({
      by: ['tenantId'],
      where: { ...scope, isActive: true },
      _max: { lastLoginAt: true },
    }),
    admin.session.groupBy({
      by: ['tenantId'],
      where: { ...scope, user: { isActive: true } },
      _max: { lastUsedAt: true },
    }),
  ]);
  const out = new Map<string, Date>();
  const take = (tenantId: string, d: Date | null | undefined) => {
    if (!d) return;
    const prev = out.get(tenantId);
    if (!prev || d > prev) out.set(tenantId, d);
  };
  for (const l of logins) take(l.tenantId, l._max.lastLoginAt);
  for (const s of sessions) take(s.tenantId, s._max.lastUsedAt);
  return out;
}

/** `lastTeamActivityByTenant` de un solo tenant (null = nunca ha entrado). */
export async function lastTeamActivity(
  admin: PrismaAdminService,
  tenantId: string,
): Promise<Date | null> {
  return (await lastTeamActivityByTenant(admin, [tenantId])).get(tenantId) ?? null;
}
