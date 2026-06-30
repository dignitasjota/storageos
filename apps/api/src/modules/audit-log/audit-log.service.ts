import { Injectable } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaService } from '../database/prisma.service';

import type { AuditLogListDto } from '@storageos/shared';

const PAGE = 50;

const include = { user: { select: { fullName: true } } } satisfies Prisma.AuditLogInclude;
type Row = Prisma.AuditLogGetPayload<{ include: typeof include }>;

/** Registro de actividad (audit log) del tenant — solo lectura. */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, cursor?: string): Promise<AuditLogListDto> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.auditLog.findMany({
          orderBy: { occurredAt: 'desc' },
          take: PAGE + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include,
        }),
      tenantId,
    );
    const hasMore = rows.length > PAGE;
    const page = hasMore ? rows.slice(0, PAGE) : rows;
    return {
      items: page.map((r: Row) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userName: r.user?.fullName ?? null,
        createdAt: r.occurredAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
