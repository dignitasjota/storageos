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

  /**
   * Agrega los eventos de la ventana indicada para el dashboard admin.
   * Devuelve KPIs, distribuciones top, timeseries y alertas activas
   * (grupos que superan `bruteForceThreshold` en la ventana).
   *
   * `bucket` controla la granularidad del timeseries:
   *   - `hour`: 1 punto por hora (usar con `windowHours <= 48`)
   *   - `day`: 1 punto por día (usar con `windowHours >= 24*7`)
   */
  async stats(args: {
    windowHours: number;
    bucket: 'hour' | 'day';
    bruteForceThreshold: number;
    topLimit?: number;
  }): Promise<SecurityEventStatsResult> {
    const since = new Date(Date.now() - args.windowHours * 60 * 60 * 1000);
    const topLimit = args.topLimit ?? 10;

    const total = await this.admin.securityEvent.count({
      where: { occurredAt: { gte: since } },
    });

    const byTypeRaw = await this.admin.securityEvent.groupBy({
      by: ['eventType'],
      where: { occurredAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { eventType: 'desc' } },
    });
    const byEventType = byTypeRaw.map((g) => ({
      eventType: g.eventType,
      count: g._count._all,
    }));

    const topEmailsRaw = await this.admin.securityEvent.groupBy({
      by: ['emailAttempted'],
      where: {
        occurredAt: { gte: since },
        emailAttempted: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { emailAttempted: 'desc' } },
      take: topLimit,
    });
    const topEmails = topEmailsRaw.map((g) => ({
      email: g.emailAttempted!,
      count: g._count._all,
      exceedsThreshold: g._count._all >= args.bruteForceThreshold,
    }));

    const topIpsRaw = await this.admin.securityEvent.groupBy({
      by: ['ipAddress'],
      where: {
        occurredAt: { gte: since },
        ipAddress: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { ipAddress: 'desc' } },
      take: topLimit,
    });
    const topIps = topIpsRaw.map((g) => ({
      ip: g.ipAddress!,
      count: g._count._all,
      exceedsThreshold: g._count._all >= args.bruteForceThreshold,
    }));

    // Timeseries: usamos SQL raw porque Prisma no soporta `date_trunc` en groupBy.
    const truncUnit = args.bucket === 'hour' ? 'hour' : 'day';
    const timeseriesRows = await this.admin.$queryRawUnsafe<Array<{ bucket: Date; count: bigint }>>(
      `SELECT date_trunc($1, occurred_at) AS bucket, COUNT(*)::bigint AS count
       FROM security_events
       WHERE occurred_at >= $2
       GROUP BY 1
       ORDER BY 1 ASC`,
      truncUnit,
      since,
    );
    const timeseries = timeseriesRows.map((r) => ({
      bucket: r.bucket.toISOString(),
      count: Number(r.count),
    }));

    const activeAlerts: SecurityEventStatsResult['activeAlerts'] = [
      ...topEmails
        .filter((t) => t.exceedsThreshold)
        .map((t) => ({ kind: 'email' as const, identifier: t.email, count: t.count })),
      ...topIps
        .filter((t) => t.exceedsThreshold)
        .map((t) => ({ kind: 'ip' as const, identifier: t.ip, count: t.count })),
    ];

    return {
      windowHours: args.windowHours,
      bucket: args.bucket,
      bruteForceThreshold: args.bruteForceThreshold,
      total,
      byEventType,
      topEmails,
      topIps,
      timeseries,
      activeAlerts,
    };
  }
}

export interface SecurityEventStatsResult {
  windowHours: number;
  bucket: 'hour' | 'day';
  bruteForceThreshold: number;
  total: number;
  byEventType: Array<{ eventType: string; count: number }>;
  topEmails: Array<{ email: string; count: number; exceedsThreshold: boolean }>;
  topIps: Array<{ ip: string; count: number; exceedsThreshold: boolean }>;
  timeseries: Array<{ bucket: string; count: number }>;
  activeAlerts: Array<{ kind: 'email' | 'ip'; identifier: string; count: number }>;
}
