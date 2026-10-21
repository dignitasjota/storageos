import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

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
/** Origen de los preavisos SEPA en `communications`. */
const SEPA_PRENOTICE_SOURCE = 'customer_email.sepa_prenotification';
/** Las exportaciones de datos del tenant se borran a los 2 días (el enlace dura 1 h). */
const EXPORT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
    private readonly files: FilesService,
  ) {}

  /**
   * Ficheros de informes y exportaciones de datos ya caducados: el enlace de
   * descarga dura poco (informes 7 días, exportaciones 1 h), pero el fichero se
   * quedaba en MinIO para siempre — y una exportación lleva datos personales de
   * todos los inquilinos del tenant.
   */
  async cleanupExpiredFiles(): Promise<{ reports: number; exports: number }> {
    const now = new Date();
    const expired = await this.admin.reportRun.findMany({
      where: { expiresAt: { lt: now }, downloadUrl: { not: null } },
      select: { id: true, downloadUrl: true },
      take: 1000,
    });
    const keys = expired
      .map((r) => this.files.keyFromPublicUrl('reports', r.downloadUrl!))
      .filter((k): k is string => !!k);
    await this.files.deleteObjects('reports', keys);
    if (expired.length > 0) {
      await this.admin.reportRun.updateMany({
        where: { id: { in: expired.map((r) => r.id) } },
        data: { status: 'expired', downloadUrl: null },
      });
    }
    // `<tenant>/exports/…`: se conservan 2 días por si hay que repetir la descarga.
    const exports = await this.files.deleteOlderThan(
      'reports',
      new Date(now.getTime() - EXPORT_RETENTION_MS),
      (key) => key.split('/')[1] === 'exports',
    );
    if (expired.length + exports > 0) {
      this.logger.log(
        `data-retention: ficheros caducados borrados (informes=${expired.length}, exportaciones=${exports})`,
      );
    }
    return { reports: expired.length, exports };
  }

  /** Borra las filas más antiguas que el plazo de retención de cada tabla. */
  async runCleanup(): Promise<{
    auditLogs: number;
    accessLogs: number;
    communications: number;
    notifications: number;
    platformEmails: number;
    whatsappConversations: number;
    whatsappMessages: number;
    webEvents: number;
  }> {
    const now = Date.now();
    const cutoff = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);

    const auditDays = this.config.get('RETENTION_AUDIT_LOGS_DAYS', { infer: true });
    const accessDays = this.config.get('RETENTION_ACCESS_LOGS_DAYS', { infer: true });
    const commsDays = this.config.get('RETENTION_COMMUNICATIONS_DAYS', { infer: true });
    const notifDays = this.config.get('RETENTION_NOTIFICATIONS_DAYS', { infer: true });
    const whatsappDays = this.config.get('RETENTION_WHATSAPP_DAYS', { infer: true });
    const webEventsDays = this.config.get('RETENTION_WEB_EVENTS_DAYS', { infer: true });
    const prenoticeDays = Math.max(
      this.config.get('RETENTION_SEPA_PRENOTICE_DAYS', { infer: true }),
      commsDays,
    );

    // Archivos de los mensajes de WhatsApp que se van a borrar.
    const whatsappCutoff = cutoff(whatsappDays);
    const expiredMedia = await this.admin.whatsappMessage.findMany({
      where: {
        mediaKey: { not: null },
        OR: [
          { createdAt: { lt: whatsappCutoff } },
          { conversation: { lastMessageAt: { lt: whatsappCutoff } } },
        ],
      },
      select: { mediaKey: true },
    });

    const [
      auditLogs,
      accessLogs,
      communications,
      notifications,
      platformEmails,
      whatsappConversations,
      whatsappMessages,
      webEvents,
    ] = await Promise.all([
      this.admin.auditLog.deleteMany({ where: { occurredAt: { lt: cutoff(auditDays) } } }),
      this.admin.accessLog.deleteMany({ where: { occurredAt: { lt: cutoff(accessDays) } } }),
      // Los preavisos SEPA se conservan más (prueba ante una devolución).
      this.admin.communication.deleteMany({
        where: {
          createdAt: { lt: cutoff(commsDays) },
          OR: [
            { source: null },
            { source: { not: SEPA_PRENOTICE_SOURCE } },
            { createdAt: { lt: cutoff(prenoticeDays) } },
          ],
        },
      }),
      this.admin.notification.deleteMany({ where: { createdAt: { lt: cutoff(notifDays) } } }),
      // Historial de correos de la plataforma: mismo plazo que Comunicaciones.
      this.admin.platformEmailLog.deleteMany({ where: { createdAt: { lt: cutoff(commsDays) } } }),
      // WhatsApp: conversaciones sin movimiento y mensajes pasado el plazo.
      this.admin.whatsappConversation.deleteMany({
        where: { lastMessageAt: { lt: cutoff(whatsappDays) } },
      }),
      this.admin.whatsappMessage.deleteMany({
        where: { createdAt: { lt: cutoff(whatsappDays) } },
      }),
      // Analítica propia de la web de los tenants.
      this.admin.webEvent.deleteMany({ where: { createdAt: { lt: cutoff(webEventsDays) } } }),
    ]);

    await this.files.deleteObjects('uploads', expiredMedia.map((m) => m.mediaKey!).filter(Boolean));

    const result = {
      auditLogs: auditLogs.count,
      accessLogs: accessLogs.count,
      communications: communications.count,
      notifications: notifications.count,
      platformEmails: platformEmails.count,
      whatsappConversations: whatsappConversations.count,
      whatsappMessages: whatsappMessages.count,
      webEvents: webEvents.count,
    };
    const total =
      result.auditLogs +
      result.accessLogs +
      result.communications +
      result.notifications +
      result.platformEmails +
      result.whatsappConversations +
      result.whatsappMessages +
      result.webEvents;
    if (total > 0) {
      this.logger.log(
        `data-retention: borradas ${total} filas ` +
          `(audit=${result.auditLogs}, access=${result.accessLogs}, ` +
          `comms=${result.communications}, notif=${result.notifications}, ` +
          `platform_emails=${result.platformEmails}, ` +
          `whatsapp=${result.whatsappConversations}/${result.whatsappMessages}, ` +
          `web_events=${result.webEvents})`,
      );
    }
    return result;
  }
}
