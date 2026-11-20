import { Injectable } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { zonedDayStart, zonedNextDayStart } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import type { AuditLogFilters, AuditLogListDto } from '@storageos/shared';

const PAGE = 50;

const include = { user: { select: { fullName: true } } } satisfies Prisma.AuditLogInclude;
type Row = Prisma.AuditLogGetPayload<{ include: typeof include }>;

/**
 * Acciones internas de la plataforma que el negocio no debe ver: lo que hace
 * el super admin sobre la cuenta (`admin.*`), las notas internas de soporte y
 * a quién del equipo de TrasterOS se asigna un ticket.
 */
const HIDDEN_PREFIX = 'admin.';
const HIDDEN_ACTIONS = ['support_ticket.internal_note_added', 'support_ticket.assigned'];
/**
 * Ruido: inicios, cierres y renovaciones de sesión. Se ocultan salvo que se
 * pidan (`includeSessions`) o se filtre por «auth». Los intentos fallidos se
 * ven siempre.
 */
const SESSION_ACTIONS = ['auth.refresh', 'auth.login.success', 'auth.logout'];
/** Claves de `changes` que delatan al super admin. */
const SUPER_ADMIN_KEYS = ['superAdminId', 'actorSuperAdminId', 'newAssignedAdminId'];

/**
 * Quita de `changes` los datos internos de la plataforma: quién del equipo de
 * TrasterOS lo hizo y su motivo. Devuelve si venía de un super admin.
 */
export function sanitizeTenantAuditChanges(changes: Prisma.JsonValue | null): {
  changes: Prisma.JsonValue | null;
  fromSuperAdmin: boolean;
} {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { changes, fromSuperAdmin: false };
  }
  const obj = changes as Record<string, Prisma.JsonValue>;
  const fromSuperAdmin = SUPER_ADMIN_KEYS.some((k) => k in obj);
  if (!fromSuperAdmin) return { changes, fromSuperAdmin };
  const clean: Record<string, Prisma.JsonValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SUPER_ADMIN_KEYS.includes(k) || k === 'reason' || k === 'previousAssignedAdminId') continue;
    clean[k] = v;
  }
  return { changes: clean, fromSuperAdmin };
}

/** Registro de actividad (audit log) del tenant — solo lectura. */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    cursor?: string,
    filters: AuditLogFilters = {},
    pageSize = PAGE,
  ): Promise<AuditLogListDto> {
    const PAGE_SIZE = pageSize;
    const rows = await this.prisma.withTenant(async (tx) => {
      // Los días de los filtros son los del negocio, no los de UTC.
      const tz =
        filters.from || filters.to
          ? ((await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }))
              ?.timezone ?? 'Europe/Madrid')
          : 'Europe/Madrid';
      const hidden = [
        ...HIDDEN_ACTIONS,
        ...(filters.includeSessions || filters.action?.startsWith('auth') ? [] : SESSION_ACTIONS),
      ];
      const where: Prisma.AuditLogWhereInput = {
        ...(filters.userId ? { userId: filters.userId } : {}),
        AND: [
          { NOT: { action: { startsWith: HIDDEN_PREFIX } } },
          { action: { notIn: hidden } },
          ...(filters.action ? [{ action: { startsWith: filters.action } }] : []),
        ],
        ...(filters.from || filters.to
          ? {
              occurredAt: {
                ...(filters.from ? { gte: zonedDayStart(filters.from, tz) } : {}),
                ...(filters.to ? { lt: zonedNextDayStart(filters.to, tz) } : {}),
              },
            }
          : {}),
      };
      return tx.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include,
      });
    }, tenantId);
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return {
      items: page.map((r: Row) => {
        const clean = sanitizeTenantAuditChanges(r.changes ?? null);
        return {
          id: r.id,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          userName: r.user?.fullName ?? (clean.fromSuperAdmin ? 'Soporte de TrasterOS' : null),
          createdAt: r.occurredAt.toISOString(),
          changes: clean.changes,
          // La IP de alguien del equipo de TrasterOS no se enseña al negocio.
          ipAddress: clean.fromSuperAdmin ? null : (r.ipAddress ?? null),
        };
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
