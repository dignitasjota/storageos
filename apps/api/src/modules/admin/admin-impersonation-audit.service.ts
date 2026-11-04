import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type {
  AdminImpersonationActivityDto,
  AdminImpersonationSessionDto,
} from '@storageos/shared';

const SESSIONS_PAGE = 50;
const IMPERSONATION_TRACKED_SINCE = new Date('2026-11-04T00:00:00Z');
const ACTIVITY_LIMIT = 200;

const SESSION_INCLUDE = {
  superAdmin: { select: { fullName: true, email: true } },
  tenant: { select: { name: true, slug: true } },
} satisfies Prisma.ImpersonationLogInclude;

type SessionRow = Prisma.ImpersonationLogGetPayload<{ include: typeof SESSION_INCLUDE }>;

/**
 * Auditoría de impersonación: lista las sesiones (`impersonation_logs`) y, por
 * cada una, la actividad del tenant registrada en `audit_logs` durante la
 * ventana de la sesión `[createdAt, revokedAt ?? expiresAt]`.
 *
 * Desde `IMPERSONATION_TRACKED_SINCE` cada acción lleva su sesión
 * (`audit_logs.impersonation_id`). En las anteriores solo hay la ventana, que
 * incluye toda la actividad del tenant en ese rato.
 */
@Injectable()
export class AdminImpersonationAuditService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly superAdminAudit: SuperAdminAuditService,
  ) {}

  private toDto(r: SessionRow, actionsCount = 0): AdminImpersonationSessionDto {
    return {
      id: r.id,
      superAdminId: r.superAdminId,
      superAdminName: r.superAdmin?.fullName ?? null,
      superAdminEmail: r.superAdmin?.email ?? null,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      tenantSlug: r.tenant.slug,
      reason: r.reason,
      readOnly: r.readOnly,
      actionsCount,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    };
  }

  async listSessions(args: {
    tenantId?: string | undefined;
    superAdminId?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ items: AdminImpersonationSessionDto[]; nextCursor: string | null }> {
    const limit = args.limit ?? SESSIONS_PAGE;
    const rows = await this.admin.impersonationLog.findMany({
      where: {
        ...(args.tenantId ? { tenantId: args.tenantId } : {}),
        ...(args.superAdminId ? { superAdminId: args.superAdminId } : {}),
      },
      include: SESSION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit);
    const counts = await this.admin.auditLog.groupBy({
      by: ['impersonationId'],
      where: { impersonationId: { in: items.map((r) => r.id) } },
      _count: { _all: true },
    });
    const countOf = (id: string): number =>
      counts.find((c) => c.impersonationId === id)?._count._all ?? 0;
    return {
      items: items.map((r) => this.toDto(r, countOf(r.id))),
      nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * "Kill switch": corta una sesión de impersonación EN CURSO antes de que
   * expire sola. `revokedAt` existía en el esquema y se mostraba en el panel
   * (badge "Revocada"), pero nada lo escribía nunca — no había ninguna acción
   * real detrás. `JwtStrategy` ahora comprueba este campo en cada request de
   * un token de impersonación (ver `jwt.strategy.ts`), así que esto SÍ
   * invalida el JWT ya emitido, no solo el registro de auditoría.
   */
  async revoke(
    sessionId: string,
    args: { superAdminId: string; ipAddress?: string | null; userAgent?: string | null },
  ): Promise<AdminImpersonationSessionDto> {
    const session = await this.admin.impersonationLog.findUnique({
      where: { id: sessionId },
      include: SESSION_INCLUDE,
    });
    if (!session) {
      throw new NotFoundException({ code: 'session_not_found', message: 'Sesión no encontrada' });
    }
    if (session.revokedAt) {
      throw new BadRequestException({
        code: 'already_revoked',
        message: 'La sesión ya estaba revocada',
      });
    }
    const updated = await this.admin.impersonationLog.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
      include: SESSION_INCLUDE,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action: 'admin.impersonation.revoked',
      targetType: 'tenant',
      targetId: session.tenantId,
      targetTenantId: session.tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes: { sessionId, originalSuperAdminId: session.superAdminId },
    });
    return this.toDto(updated);
  }

  /** Actividad del tenant durante la ventana de la sesión de impersonación. */
  async getActivity(sessionId: string): Promise<AdminImpersonationActivityDto[]> {
    const session = await this.admin.impersonationLog.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException({ code: 'session_not_found', message: 'Sesión no encontrada' });
    }
    const windowEnd = session.revokedAt ?? session.expiresAt;
    const rows = await this.admin.auditLog.findMany({
      where:
        session.createdAt >= IMPERSONATION_TRACKED_SINCE
          ? { impersonationId: session.id }
          : {
              tenantId: session.tenantId,
              occurredAt: { gte: session.createdAt, lte: windowEnd },
            },
      include: { user: { select: { fullName: true } } },
      orderBy: { occurredAt: 'desc' },
      take: ACTIVITY_LIMIT,
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      userName: r.user?.fullName ?? null,
      occurredAt: r.occurredAt.toISOString(),
    }));
  }
}
