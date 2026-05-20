import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SecurityEvent, type SecurityEventType } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';

/** Argumentos para persistir un evento de seguridad. */
export interface RecordSecurityEventArgs {
  eventType: SecurityEventType;
  emailAttempted?: string | null | undefined;
  tenantSlugAttempted?: string | null | undefined;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
  reason?: string | null | undefined;
  rawMetadata?: Record<string, unknown> | undefined;
}

/** Filtros para listar eventos. */
export interface ListSecurityEventsArgs {
  eventType?: SecurityEventType | undefined;
  emailAttempted?: string | undefined;
  fromDate?: Date | undefined;
  toDate?: Date | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface ListSecurityEventsResult {
  items: SecurityEvent[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Persiste y consulta eventos de seguridad globales (sin tenant context).
 *
 * Se utiliza desde AuthService / SessionsService cuando el flujo de auth
 * recibe peticiones contra slugs o emails inexistentes, throttles, reuso
 * de refresh tokens, etc. La tabla `security_events` es global (sin RLS)
 * y solo es accesible via `PrismaAdminService`. El endpoint
 * `/admin/security-events` la expone al super admin.
 *
 * Retencion 90 dias gestionada por cron diario (`cleanup`).
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /**
   * Persiste un evento de seguridad. No throwea si la BD falla: el flujo
   * de auth no debe romperse porque la auditoria no este disponible. En
   * ese caso loggea con `warn` para que quede traza en pino.
   */
  async record(args: RecordSecurityEventArgs): Promise<void> {
    try {
      await this.admin.securityEvent.create({
        data: {
          eventType: args.eventType,
          emailAttempted: args.emailAttempted ?? null,
          tenantSlugAttempted: args.tenantSlugAttempted ?? null,
          ipAddress: args.ipAddress ?? null,
          userAgent: args.userAgent ?? null,
          reason: args.reason ?? null,
          // Prisma diferencia null SQL vs JsonNull: usamos DbNull para que
          // la columna quede NULL en SQL (no el JSON literal `null`).
          rawMetadata:
            args.rawMetadata === undefined || args.rawMetadata === null
              ? Prisma.DbNull
              : (args.rawMetadata as Prisma.InputJsonValue),
        },
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo persistir security_event ${args.eventType}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Lista eventos con paginacion cursor (id desc + occurredAt desc). El
   * cursor es el `id` del ultimo elemento de la pagina anterior. Limit
   * default 50, maximo 200.
   */
  async list(args: ListSecurityEventsArgs): Promise<ListSecurityEventsResult> {
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const where: Prisma.SecurityEventWhereInput = {};
    if (args.eventType) where.eventType = args.eventType;
    if (args.emailAttempted) {
      where.emailAttempted = { equals: args.emailAttempted.trim().toLowerCase() };
    }
    if (args.fromDate || args.toDate) {
      where.occurredAt = {};
      if (args.fromDate) where.occurredAt.gte = args.fromDate;
      if (args.toDate) where.occurredAt.lte = args.toDate;
    }

    const rows = await this.admin.securityEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items, nextCursor };
  }

  /**
   * Borra eventos con `occurred_at < now() - INTERVAL 'X days'`. Default 90.
   * Usado por el cron diario `security-events.cleanup`.
   */
  async cleanup(olderThanDays: number = 90): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.admin.securityEvent.deleteMany({
      where: { occurredAt: { lt: cutoff } },
    });
    return { deleted: result.count };
  }
}
