import { Injectable } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaService } from '../database/prisma.service';

import type { AuditLogFilters, AuditLogListDto } from '@storageos/shared';

const PAGE = 50;

const include = { user: { select: { fullName: true } } } satisfies Prisma.AuditLogInclude;
type Row = Prisma.AuditLogGetPayload<{ include: typeof include }>;

/** Día siguiente a `YYYY-MM-DD` (para incluir el día entero en el filtro). */
function nextDay(date: string): Date {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
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
    const where: Prisma.AuditLogWhereInput = {
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.action ? { action: { startsWith: filters.action } } : {}),
      ...(filters.from || filters.to
        ? {
            occurredAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lt: nextDay(filters.to) } : {}),
            },
          }
        : {}),
    };
    const PAGE_SIZE = pageSize;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.auditLog.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: PAGE_SIZE + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include,
        }),
      tenantId,
    );
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return {
      items: page.map((r: Row) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userName: r.user?.fullName ?? null,
        createdAt: r.occurredAt.toISOString(),
        changes: r.changes ?? null,
        ipAddress: r.ipAddress ?? null,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
