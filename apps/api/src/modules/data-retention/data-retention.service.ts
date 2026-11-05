import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { attachmentKeysOf } from '../../common/message-attachments';
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

/** Días que se conserva una invitación no aceptada tras caducar o revocarse. */
const STALE_INVITATION_DAYS = 90;

/** Días que se guardan las conversaciones del chat de la web. */
const WEB_CHAT_RETENTION_DAYS = 90;

/** Días que se guarda la IP de quien escribe por el formulario de contacto. */
const CONTACT_IP_DAYS = 90;

/** Horas que se espera a que un adjunto subido llegue a enviarse. */
const ORPHAN_ATTACHMENT_HOURS = 24;

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
  /**
   * Adjuntos subidos y nunca enviados (se cerró la conversación con el mensaje a
   * medias): pasado un día nadie los va a usar y solo ocupan espacio.
   */
  async cleanupOrphanAttachments(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - ORPHAN_ATTACHMENT_HOURS * 3_600_000);
    const tenants = await this.admin.tenant.findMany({ select: { id: true } });
    let removed = 0;
    for (const { id: tenantId } of tenants) {
      const keys = [
        ...(await this.files.listOlderThan('uploads', `${tenantId}/chat/`, before)),
        ...(await this.files.listOlderThan('uploads', `${tenantId}/support/`, before)),
      ];
      if (keys.length === 0) continue;
      // Los que van de segundos en un mensaje no se pueden buscar por columna.
      const [chatExtras, ticketExtras] = await Promise.all([
        this.admin.customerMessage.findMany({
          where: { tenantId, NOT: { extraAttachments: { equals: [] } } },
          select: { attachmentKey: true, extraAttachments: true },
        }),
        this.admin.supportTicketMessage.findMany({
          where: { ticket: { tenantId }, NOT: { extraAttachments: { equals: [] } } },
          select: { attachmentKey: true, extraAttachments: true },
        }),
      ]);
      const extras = new Set([...chatExtras, ...ticketExtras].flatMap(attachmentKeysOf));
      for (let i = 0; i < keys.length; i += 500) {
        const batch = keys.slice(i, i + 500);
        const [chat, tickets] = await Promise.all([
          this.admin.customerMessage.findMany({
            where: { tenantId, attachmentKey: { in: batch } },
            select: { attachmentKey: true },
          }),
          this.admin.supportTicketMessage.findMany({
            where: { ticket: { tenantId }, attachmentKey: { in: batch } },
            select: { attachmentKey: true },
          }),
        ]);
        const used = new Set([...chat, ...tickets].map((r) => r.attachmentKey));
        const orphans = batch.filter((k) => !used.has(k) && !extras.has(k));
        await this.files.deleteObjects('uploads', orphans);
        removed += orphans.length;
      }
    }
    return removed;
  }

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
    webChatConversations: number;
    waitlistEntries: number;
    adminSessions: number;
    impersonationLogs: number;
    superAdminAuditLogs: number;
  }> {
    const now = Date.now();
    const cutoff = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);

    const auditDays = this.config.get('RETENTION_AUDIT_LOGS_DAYS', { infer: true });
    const accessDays = this.config.get('RETENTION_ACCESS_LOGS_DAYS', { infer: true });
    const commsDays = this.config.get('RETENTION_COMMUNICATIONS_DAYS', { infer: true });
    const notifDays = this.config.get('RETENTION_NOTIFICATIONS_DAYS', { infer: true });
    const whatsappDays = this.config.get('RETENTION_WHATSAPP_DAYS', { infer: true });
    const webEventsDays = this.config.get('RETENTION_WEB_EVENTS_DAYS', { infer: true });
    const waitlistDays = this.config.get('RETENTION_WAITLIST_DAYS', { infer: true });
    const contactDays = this.config.get('RETENTION_CONTACT_MESSAGES_DAYS', { infer: true });
    const adminSessionDays = this.config.get('RETENTION_ADMIN_SESSIONS_DAYS', { infer: true });
    const impersonationDays = this.config.get('RETENTION_IMPERSONATION_LOGS_DAYS', { infer: true });
    const adminAuditDays = this.config.get('RETENTION_SUPER_ADMIN_AUDIT_DAYS', { infer: true });
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
      webChatConversations,
      waitlistEntries,
      contactMessages,
      adminSessions,
      impersonationLogs,
      superAdminAuditLogs,
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
      // Chat con IA de la web: conversaciones sin movimiento en 90 días (con sus mensajes).
      this.admin.webChatConversation.deleteMany({
        where: { lastMessageAt: { lt: cutoff(WEB_CHAT_RETENTION_DAYS) } },
      }),
      // Lista de espera: contactos sin ficha cuya entrada ya está cerrada.
      this.admin.waitlistEntry.deleteMany({
        where: {
          customerId: null,
          status: { in: ['converted', 'cancelled', 'expired'] },
          updatedAt: { lt: cutoff(waitlistDays) },
        },
      }),
      // Formulario de contacto de trasteros.pro: datos de visitantes.
      this.admin.platformContactMessage.deleteMany({
        where: { createdAt: { lt: cutoff(contactDays) } },
      }),
      // Sesiones del panel admin ya caducadas (cada refresco crea una fila).
      this.admin.superAdminSession.deleteMany({
        where: { expiresAt: { lt: cutoff(adminSessionDays) } },
      }),
      this.admin.impersonationLog.deleteMany({
        where: { createdAt: { lt: cutoff(impersonationDays) } },
      }),
      this.admin.superAdminAuditLog.deleteMany({
        where: { occurredAt: { lt: cutoff(adminAuditDays) } },
      }),
    ]);
    // La IP del visitante solo hace falta los primeros días (abusos).
    await this.admin.platformContactMessage.updateMany({
      where: { ipAddress: { not: null }, createdAt: { lt: cutoff(CONTACT_IP_DAYS) } },
      data: { ipAddress: null },
    });

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
      webChatConversations: webChatConversations.count,
      waitlistEntries: waitlistEntries.count,
      contactMessages: contactMessages.count,
      adminSessions: adminSessions.count,
      impersonationLogs: impersonationLogs.count,
      superAdminAuditLogs: superAdminAuditLogs.count,
    };
    const total =
      result.auditLogs +
      result.accessLogs +
      result.communications +
      result.notifications +
      result.platformEmails +
      result.whatsappConversations +
      result.whatsappMessages +
      result.webEvents +
      result.webChatConversations +
      result.waitlistEntries +
      result.contactMessages +
      result.adminSessions +
      result.impersonationLogs +
      result.superAdminAuditLogs;
    if (total > 0) {
      this.logger.log(
        `data-retention: borradas ${total} filas ` +
          `(audit=${result.auditLogs}, access=${result.accessLogs}, ` +
          `comms=${result.communications}, notif=${result.notifications}, ` +
          `platform_emails=${result.platformEmails}, ` +
          `whatsapp=${result.whatsappConversations}/${result.whatsappMessages}, ` +
          `web_events=${result.webEvents}, web_chat=${result.webChatConversations}, lista_espera=${result.waitlistEntries}, contacto=${result.contactMessages}, ` +
          `admin_sessions=${result.adminSessions}, impersonations=${result.impersonationLogs}, ` +
          `admin_audit=${result.superAdminAuditLogs})`,
      );
    }
    return result;
  }

  /**
   * Invitaciones que no se aceptaron (caducadas o revocadas) hace más de
   * 90 días: ya no sirven y solo ensucian la lista del equipo.
   */
  async cleanupStaleInvitations(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_INVITATION_DAYS * 24 * 60 * 60 * 1000);
    const res = await this.admin.invitation.deleteMany({
      where: {
        acceptedAt: null,
        OR: [{ revokedAt: { lt: cutoff } }, { revokedAt: null, expiresAt: { lt: cutoff } }],
      },
    });
    if (res.count > 0)
      this.logger.log(`data-retention: ${res.count} invitaciones antiguas borradas`);
    return res.count;
  }
}
