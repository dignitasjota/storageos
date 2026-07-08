import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';

/**
 * Retención de datos: borra filas antiguas de las tablas de crecimiento
 * ilimitado (audit_logs, access_logs, communications, notifications) para no
 * llenar el disco del VPS ni degradar inserts/backups. Cross-tenant vía
 * `PrismaAdminService` (bypass RLS) — es mantenimiento global por antigüedad, no
 * una operación de tenant. Los plazos son configurables por env; el de
 * audit_logs es conservador (24 meses) por su valor de compliance.
 *
 * NO incluye tablas con obligación fiscal (invoices, payments) ni las que ya
 * tienen su propio cleanup (security_events 90d, webhook_deliveries, stripe_events).
 */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Borra las filas más antiguas que el plazo de retención de cada tabla. */
  async runCleanup(): Promise<{
    auditLogs: number;
    accessLogs: number;
    communications: number;
    notifications: number;
  }> {
    const now = Date.now();
    const cutoff = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);

    const auditDays = this.config.get('RETENTION_AUDIT_LOGS_DAYS', { infer: true });
    const accessDays = this.config.get('RETENTION_ACCESS_LOGS_DAYS', { infer: true });
    const commsDays = this.config.get('RETENTION_COMMUNICATIONS_DAYS', { infer: true });
    const notifDays = this.config.get('RETENTION_NOTIFICATIONS_DAYS', { infer: true });

    const [auditLogs, accessLogs, communications, notifications] = await Promise.all([
      this.admin.auditLog.deleteMany({ where: { occurredAt: { lt: cutoff(auditDays) } } }),
      this.admin.accessLog.deleteMany({ where: { occurredAt: { lt: cutoff(accessDays) } } }),
      this.admin.communication.deleteMany({ where: { createdAt: { lt: cutoff(commsDays) } } }),
      this.admin.notification.deleteMany({ where: { createdAt: { lt: cutoff(notifDays) } } }),
    ]);

    const result = {
      auditLogs: auditLogs.count,
      accessLogs: accessLogs.count,
      communications: communications.count,
      notifications: notifications.count,
    };
    const total =
      result.auditLogs + result.accessLogs + result.communications + result.notifications;
    if (total > 0) {
      this.logger.log(
        `data-retention: borradas ${total} filas ` +
          `(audit=${result.auditLogs}, access=${result.accessLogs}, ` +
          `comms=${result.communications}, notif=${result.notifications})`,
      );
    }
    return result;
  }
}
