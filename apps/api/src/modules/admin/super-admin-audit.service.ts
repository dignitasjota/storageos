import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SuperAdminAuditLog } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';

/** Argumentos para persistir una entrada de audit log del super admin. */
export interface RecordSuperAdminAuditArgs {
  superAdminId?: string | null | undefined;
  action: string;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  targetTenantId?: string | null | undefined;
  changes?: Record<string, unknown> | null | undefined;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

/** Filtros para listar audit logs. */
export interface ListSuperAdminAuditLogsArgs {
  superAdminId?: string | undefined;
  action?: string | undefined;
  targetTenantId?: string | undefined;
  fromDate?: Date | undefined;
  toDate?: Date | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Forma del row con el super admin incluido (para denormalizar email). */
export type SuperAdminAuditLogWithActor = SuperAdminAuditLog & {
  superAdmin: { email: string; fullName: string } | null;
};

export interface ListSuperAdminAuditLogsResult {
  items: SuperAdminAuditLogWithActor[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Persiste y consulta audit logs globales del super admin (Fase 12A.3).
 *
 * Las acciones del super admin (login, 2FA, impersonation, suspend/reactivate
 * de tenants, etc.) no pueden ir a `audit_logs` porque esa tabla requiere
 * `tenant_id NOT NULL`. Esta tabla es global (sin RLS) y solo es accesible
 * via `PrismaAdminService`. El endpoint `/admin/audit-logs` la expone al
 * super admin.
 *
 * `record()` NO throwea si la BD falla: el flujo del super admin no debe
 * romperse porque la auditoria no este disponible. En ese caso loggea con
 * `error` para que quede traza en pino / Loki.
 */
@Injectable()
export class SuperAdminAuditService {
  private readonly logger = new Logger(SuperAdminAuditService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /**
   * Persiste una entrada de audit log. Silenciosamente swallows errores
   * para no romper el flow del caller — el logger ya deja rastro.
   */
  async record(args: RecordSuperAdminAuditArgs): Promise<void> {
    try {
      await this.admin.superAdminAuditLog.create({
        data: {
          superAdminId: args.superAdminId ?? null,
          action: args.action,
          targetType: args.targetType ?? null,
          targetId: args.targetId ?? null,
          targetTenantId: args.targetTenantId ?? null,
          // Prisma diferencia null SQL vs JsonNull: usamos DbNull para que
          // la columna quede NULL en SQL (no el JSON literal `null`).
          changes:
            args.changes === undefined || args.changes === null
              ? Prisma.DbNull
              : (args.changes as Prisma.InputJsonValue),
          ipAddress: args.ipAddress ?? null,
          userAgent: args.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo persistir super_admin_audit_log ${args.action}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Lista entradas con paginacion cursor (occurredAt desc + id desc). El
   * cursor es el `id` de la ultima entrada de la pagina anterior. Limit
   * default 50, maximo 200.
   */
  async list(args: ListSuperAdminAuditLogsArgs): Promise<ListSuperAdminAuditLogsResult> {
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const where: Prisma.SuperAdminAuditLogWhereInput = {};
    if (args.superAdminId) where.superAdminId = args.superAdminId;
    if (args.action) where.action = args.action;
    if (args.targetTenantId) where.targetTenantId = args.targetTenantId;
    if (args.fromDate || args.toDate) {
      where.occurredAt = {};
      if (args.fromDate) where.occurredAt.gte = args.fromDate;
      if (args.toDate) where.occurredAt.lte = args.toDate;
    }

    const rows = await this.admin.superAdminAuditLog.findMany({
      where,
      include: {
        superAdmin: { select: { email: true, fullName: true } },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items, nextCursor };
  }
}
