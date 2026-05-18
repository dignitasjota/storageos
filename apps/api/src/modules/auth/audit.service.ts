import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';

export interface AuditEntry {
  tenantId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Servicio centralizado para escribir audit logs.
 *
 * Usa el cliente admin (bypass RLS) por dos razones:
 *   1. La escritura nunca debe fallar por falta de contexto de tenant
 *      (p. ej. justo despues de `register` cuando el caller aun no tiene
 *      sesion).
 *   2. Algunos flujos (refresh con sesion ya revocada) escriben con el
 *      `tenantId` resuelto pero sin que el caller sea de ese tenant.
 *
 * No propaga errores: si el insert falla, lo logueamos a stderr pero no
 * rompemos el flujo principal del usuario.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  async write(entry: AuditEntry): Promise<void> {
    try {
      await this.admin.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          changes: entry.changes ?? {},
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Fallo al escribir audit log "${entry.action}" para tenant ${entry.tenantId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
