import { todayInTimezone } from './format';

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
 * Cada renovación del token crea una sesión nueva enlazada a la anterior
 * (`rotated_from_id`), así que solo esas cuentan como uso: la sesión que se
 * abre sola al registrarse no es «haber entrado» (si no, nadie saldría nunca
 * como «nunca entró»). Los inicios de sesión ya cuentan por `last_login_at`.
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
      where: { ...scope, user: { isActive: true }, rotatedFromId: { not: null } },
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

const DAY_MS = 86_400_000;

/**
 * Anota que el usuario ha usado el panel hoy (hora de España): una fila por
 * usuario y día en `tenant_activity_days`. Solo escribe la primera vez del día
 * (`users.last_active_day`), así que renovar la sesión cada pocos minutos no
 * cuesta nada. Nunca falla: si algo va mal, se pierde ese día y ya.
 */
export async function recordTeamActivityDay(
  admin: PrismaAdminService,
  user: { id: string; tenantId: string; lastActiveDay?: Date | null },
  now = new Date(),
): Promise<void> {
  const day = todayInTimezone('Europe/Madrid', now);
  if (user.lastActiveDay && user.lastActiveDay.getTime() === day.getTime()) return;
  const key = day.toISOString().slice(0, 10);
  try {
    await admin.$executeRaw`
      WITH u AS (
        UPDATE users SET last_active_day = ${key}::date
        WHERE id = ${user.id}::uuid AND last_active_day IS DISTINCT FROM ${key}::date
        RETURNING id, tenant_id
      )
      INSERT INTO tenant_activity_days (tenant_id, user_id, day)
      SELECT tenant_id, id, ${key}::date FROM u
      ON CONFLICT DO NOTHING`;
  } catch {
    /* la actividad es informativa: no rompe el inicio de sesión */
  }
}

export interface TeamActivityStats {
  /** Días distintos con alguien del equipo en el panel (últimos 30). */
  activeDays: number;
  /** Usuarios distintos que entraron en esos 30 días. */
  activeUsers: number;
  /** Primer día registrado (para saber si ya hay un mes de historia). */
  firstDay: Date;
}

/**
 * Días y usuarios activos de los últimos 30 días por tenant (los que no tienen
 * ningún día registrado no aparecen: aún no hay datos).
 */
export async function teamActivityStatsByTenant(
  admin: PrismaAdminService,
  tenantIds?: string[],
  now = new Date(),
): Promise<Map<string, TeamActivityStats>> {
  if (tenantIds && tenantIds.length === 0) return new Map();
  const today = todayInTimezone('Europe/Madrid', now);
  const since = new Date(today.getTime() - 29 * DAY_MS);
  const ids = tenantIds ?? null;
  const rows = await admin.$queryRaw<
    { tenant_id: string; days: bigint; users: bigint; first_day: Date }[]
  >`
    SELECT tenant_id::text AS tenant_id,
           COUNT(DISTINCT day) FILTER (WHERE day >= ${since}::date) AS days,
           COUNT(DISTINCT user_id) FILTER (WHERE day >= ${since}::date) AS users,
           MIN(day) AS first_day
    FROM tenant_activity_days
    WHERE (${ids}::uuid[] IS NULL OR tenant_id = ANY(${ids}::uuid[]))
    GROUP BY tenant_id`;
  return new Map(
    rows.map((r) => [
      r.tenant_id,
      { activeDays: Number(r.days), activeUsers: Number(r.users), firstDay: r.first_day },
    ]),
  );
}
