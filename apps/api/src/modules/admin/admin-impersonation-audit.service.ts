import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminImpersonationActivityDto,
  AdminImpersonationSessionDto,
} from '@storageos/shared';

const SESSIONS_LIMIT = 100;
const ACTIVITY_LIMIT = 200;

/**
 * Auditoría de impersonación: lista las sesiones (`impersonation_logs`) y, por
 * cada una, la actividad del tenant registrada en `audit_logs` durante la
 * ventana de la sesión `[createdAt, revokedAt ?? expiresAt]`.
 *
 * Nota: la ventana captura toda la actividad del tenant en ese rato (no solo la
 * del admin). Marcar cada acción con el impersonador requeriría tocar el
 * AuditService global y queda como follow-up.
 */
@Injectable()
export class AdminImpersonationAuditService {
  constructor(private readonly admin: PrismaAdminService) {}

  async listSessions(tenantId?: string): Promise<AdminImpersonationSessionDto[]> {
    const rows = await this.admin.impersonationLog.findMany({
      where: tenantId ? { tenantId } : {},
      include: {
        superAdmin: { select: { fullName: true, email: true } },
        tenant: { select: { name: true, slug: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: SESSIONS_LIMIT,
    });
    return rows.map((r) => ({
      id: r.id,
      superAdminId: r.superAdminId,
      superAdminName: r.superAdmin?.fullName ?? null,
      superAdminEmail: r.superAdmin?.email ?? null,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      tenantSlug: r.tenant.slug,
      reason: r.reason,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    }));
  }

  /** Actividad del tenant durante la ventana de la sesión de impersonación. */
  async getActivity(sessionId: string): Promise<AdminImpersonationActivityDto[]> {
    const session = await this.admin.impersonationLog.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException({ code: 'session_not_found', message: 'Sesión no encontrada' });
    }
    const windowEnd = session.revokedAt ?? session.expiresAt;
    const rows = await this.admin.auditLog.findMany({
      where: {
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
