import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  type AnnouncementSegment,
  fillAdminMessageVariables,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  renderAdminEmail,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { buildUnsubscribeToken, unsubscribeKey } from '../../common/marketing/unsubscribe-token';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { AdminSegmentService, type SegmentRecipient } from './admin-segment.service';
import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Env } from '../../config/env.schema';
import type {
  TenantPlatformMessageDto,
  TenantPlatformMessagesPageDto,
  AdminBroadcastInput,
  AdminBroadcastResultDto,
  AdminEmailTenantInput,
  AdminEmailTenantResultDto,
  RetentionPlaybookResultDto,
} from '@storageos/shared';

interface ActionMeta {
  superAdminId: string;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

interface QueuedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  announcementId?: string;
}

/** Fichero adjunto a un mensaje de TrasterOS (bucket privado `uploads`). */
interface StoredFile {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Comunicación del super admin con los tenants: email directo a un tenant y
 * anuncios masivos (broadcast). Envía a los **owners verificados activos** de
 * cada tenant (fallback al `billingEmail`). Cross-tenant vía `PrismaAdminService`
 * + `EmailService.sendRendered`. Audita en `super_admin_audit_logs`.
 */
@Injectable()
export class AdminCommsService {
  private readonly webBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly unsubscribeKey: Buffer;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly followups: AdminTenantFollowupsService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    private readonly notifications: NotificationsService,
    private readonly segments: AdminSegmentService,
    private readonly files: FilesService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.apiBaseUrl = config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.unsubscribeKey = unsubscribeKey(config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
  }

  /** Pie de un anuncio comercial con el enlace de baja del usuario. */
  private unsubscribeFooter(userId: string): {
    footerHtml: string;
    footerText: string;
    headers: Record<string, string>;
  } {
    const token = encodeURIComponent(buildUnsubscribeToken(this.unsubscribeKey, 'u', userId));
    const url = `${this.webBaseUrl}/unsubscribe/${token}`;
    const why = 'Recibes este correo porque usas TrasterOS.';
    return {
      footerHtml: `${why} <a href="${url}" style="color:#64748b">Darme de baja de las novedades y ofertas</a><br>`,
      footerText: `${why}\nDarme de baja de las novedades y ofertas: ${url}`,
      headers: {
        'List-Unsubscribe': `<${this.apiBaseUrl}/v1/public/unsubscribe/${token}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  /** Emails de destino de un tenant: owners verificados activos o billingEmail. */
  private async recipientsFor(tenantId: string): Promise<string[]> {
    return (await this.namedRecipientsFor(tenantId)).map((r) => r.email);
  }

  private async namedRecipientsFor(tenantId: string): Promise<SegmentRecipient[]> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, billingEmail: true },
    });
    if (!tenant) return [];
    return this.segments.recipientsFor([tenant], false);
  }

  private async sendTo(
    recipients: string[] | SegmentRecipient[],
    subject: string,
    body: string,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const r of recipients) {
      const to = typeof r === 'string' ? r : r.email;
      const filled =
        typeof r === 'string'
          ? { subject, body }
          : {
              subject: fillAdminMessageVariables(subject, {
                empresa: r.tenantName,
                nombre: r.fullName,
              }),
              body: fillAdminMessageVariables(body, { empresa: r.tenantName, nombre: r.fullName }),
            };
      const { html, text } = renderAdminEmail(filled.body);
      try {
        const result = await this.email.sendRendered({
          to,
          kind: 'admin_message',
          subject: filled.subject,
          html,
          text,
        });
        // Dirección bloqueada (rebote permanente): no ha salido.
        if (result.suppressed) failed += 1;
        else sent += 1;
      } catch {
        failed += 1;
      }
    }
    return { sent, failed };
  }

  /**
   * Correo directo: abre un ticket «esperando tu respuesta» con el mensaje del
   * admin (para responderlo desde el panel). Marcado como abierto por el admin:
   * no cuenta en los tiempos de respuesta del soporte.
   */
  private async openDirectTicket(
    tenantId: string,
    input: { subject: string; body: string },
    superAdminId: string,
  ): Promise<string> {
    const ticket = await this.admin.supportTicket.create({
      data: {
        tenantId,
        subject: input.subject,
        priority: 'normal',
        category: 'trasteros',
        status: 'waiting_user',
        openedByAdmin: true,
        messages: {
          create: { authorAdminId: superAdminId, body: input.body, isInternal: false },
        },
      },
      select: { id: true },
    });
    return ticket.id;
  }

  /** Tras enviarlo: queda en «Mensajes de TrasterOS» y avisa en el panel. */
  private async recordDirectMessage(
    tenantId: string,
    ticketId: string | null,
    input: { subject: string; body: string },
    superAdminId: string,
    attachments: StoredFile[] = [],
  ): Promise<void> {
    await this.admin.tenantPlatformMessage.create({
      data: {
        tenantId,
        kind: 'direct',
        subject: input.subject,
        body: input.body,
        ticketId,
        superAdminId,
        attachments: attachments as unknown as Prisma.InputJsonValue,
      },
    });
    const notice = {
      type: 'platform.message',
      title: `Mensaje de TrasterOS: ${input.subject}`,
      body: input.body.slice(0, 140),
    };
    // Con ticket lo ve todo el equipo; sin él, solo quien lee estos mensajes.
    if (ticketId) {
      await this.notifications
        .create(tenantId, { ...notice, link: `/support/${ticketId}` })
        .catch(() => undefined);
      return;
    }
    await this.admin.notification
      .createMany({
        data: (await this.platformReaders([tenantId])).map((u) => ({
          ...notice,
          tenantId: u.tenantId,
          userId: u.id,
          link: '/support?tab=trasteros',
        })),
      })
      .catch(() => undefined);
  }

  /** Quien puede leer los mensajes de TrasterOS: propietario, gestor o rol a medida con el permiso. */
  private platformReaders(tenantIds: string[]) {
    return this.admin.user.findMany({
      where: {
        tenantId: { in: tenantIds },
        isActive: true,
        OR: [
          { role: 'owner' },
          { role: 'manager', tenantRoleId: null },
          { tenantRole: { permissions: { has: 'platform_messages:manage' } } },
        ],
      },
      select: { id: true, tenantId: true },
    });
  }

  /** Subida de un adjunto del correo directo (bucket privado). */
  async requestDirectFileUpload(
    tenantId: string,
    input: { fileName: string; mimeType: string; size: number },
  ): Promise<{ uploadUrl: string; key: string; requiredHeaders: Record<string, string> }> {
    const safe = input.fileName.replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'adjunto';
    const key = `${tenantId}/platform-messages/${randomUUID()}/${safe}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: input.mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': input.mimeType } };
  }

  private async checkFiles(tenantId: string, files: StoredFile[]): Promise<StoredFile[]> {
    const prefix = `${tenantId}/platform-messages/`;
    for (const f of files) {
      if (!f.key.startsWith(prefix) || f.key.includes('..')) {
        throw new BadRequestException({ code: 'invalid_attachment', message: 'Adjunto no válido' });
      }
      await this.files.assertObjectMimeType(
        'uploads',
        f.key,
        [f.mimeType],
        MESSAGE_ATTACHMENT_MAX_BYTES,
      );
    }
    return files.map((f) => ({ ...f, name: f.name.replace(/[\r\n"]/g, ' ').slice(0, 200) }));
  }

  /** URL firmada (10 min) de un adjunto de un mensaje de TrasterOS del tenant. */
  async platformMessageFileUrl(
    tenantId: string,
    messageId: string,
    index: number,
  ): Promise<string> {
    const row = await this.admin.tenantPlatformMessage.findFirst({
      where: { id: messageId, tenantId },
      select: { attachments: true },
    });
    const file = (row?.attachments as unknown as StoredFile[] | undefined)?.[index];
    if (!file) {
      throw new NotFoundException({
        code: 'attachment_not_found',
        message: 'Adjunto no encontrado',
      });
    }
    return this.files.getPresignedGetUrl('uploads', file.key, 600, file.name);
  }

  /** Anuncio o correo de retención: queda en el panel de cada tenant y le avisa. */
  private async recordBroadcast(
    tenantIds: string[],
    input: { subject: string; body: string },
    superAdminId: string | null,
    kind: 'announcement' | 'retention' = 'announcement',
  ): Promise<void> {
    if (tenantIds.length === 0) return;
    await this.admin.tenantPlatformMessage.createMany({
      data: tenantIds.map((tenantId) => ({
        tenantId,
        kind,
        subject: input.subject,
        body: input.body,
        superAdminId,
      })),
    });
    await this.admin.notification.createMany({
      data: (await this.platformReaders(tenantIds)).map((u) => ({
        tenantId: u.tenantId,
        userId: u.id,
        type: 'platform.message',
        title: `Mensaje de TrasterOS: ${input.subject}`,
        body: input.body.slice(0, 140),
        link: '/support?tab=trasteros',
      })),
    });
  }

  /** Mensajes de TrasterOS al tenant (cara tenant, Soporte), de 30 en 30. */
  async listForTenant(
    tenantId: string,
    userId: string,
    cursor?: string,
  ): Promise<TenantPlatformMessagesPageDto> {
    const take = 30;
    // Hasta cuándo ha leído esta persona (o desde su alta: no hereda lo anterior).
    const [read, user] = await Promise.all([
      this.admin.tenantPlatformMessageRead.findUnique({ where: { userId } }),
      this.admin.user.findFirst({ where: { id: userId, tenantId }, select: { createdAt: true } }),
    ]);
    const readUntil = read?.lastReadAt ?? user?.createdAt ?? new Date(0);
    const [rows, unread] = await Promise.all([
      this.admin.tenantPlatformMessage.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      this.admin.tenantPlatformMessage.count({
        where: { tenantId, createdAt: { gt: readUntil } },
      }),
    ]);
    const page = rows.slice(0, take);
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind as TenantPlatformMessageDto['kind'],
        subject: r.subject,
        body: r.body,
        ticketId: r.ticketId,
        attachments: ((r.attachments as unknown as StoredFile[] | null) ?? []).map((f) => ({
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
        })),
        readAt: r.createdAt <= readUntil ? readUntil.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      unread,
    };
  }

  /** Abrir la pestaña deja todo leído para quien la abre, no para el resto del equipo. */
  async markReadForTenant(tenantId: string, userId: string): Promise<void> {
    const now = new Date();
    await this.admin.tenantPlatformMessageRead.upsert({
      where: { userId },
      create: { userId, tenantId, lastReadAt: now },
      update: { lastReadAt: now },
    });
  }

  /** Encola un email por destinatario en la cola BullMQ `email`. */
  private async enqueue(recipients: string[], subject: string, body: string): Promise<void> {
    if (recipients.length === 0) return;
    const { html, text } = renderAdminEmail(body);
    await this.enqueueRendered(recipients.map((to) => ({ to, subject, html, text })));
  }

  private async enqueueRendered(emails: QueuedEmail[]): Promise<void> {
    if (emails.length === 0) return;
    await this.emailQueue.addBulk(
      emails.map((e) => ({
        name: JOB_EMAIL_SEND,
        data: {
          to: e.to,
          kind: 'admin_message',
          subject: e.subject,
          html: e.html,
          text: e.text,
          ...(e.headers ? { headers: e.headers } : {}),
          ...(e.announcementId ? { announcementId: e.announcementId } : {}),
        },
      })),
    );
  }

  async emailTenant(
    tenantId: string,
    input: AdminEmailTenantInput,
    meta: ActionMeta,
  ): Promise<AdminEmailTenantResultDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const recipients = await this.namedRecipientsFor(tenantId);
    if (recipients.length === 0) {
      throw new BadRequestException({
        code: 'no_recipients',
        message: 'El tenant no tiene destinatarios (owner verificado o email de facturación).',
      });
    }
    const files = await this.checkFiles(tenantId, input.attachments ?? []);
    // El texto guardado lleva las variables con los datos del tenant.
    const tenantName = recipients[0]?.tenantName ?? '';
    const stored = {
      subject: fillAdminMessageVariables(input.subject, { empresa: tenantName }),
      body: fillAdminMessageVariables(input.body, { empresa: tenantName }),
    };
    // El ticket hace falta antes de enviar (el correo lleva su enlace). Si el
    // correo no sale a nadie, se borra: el tenant no debe ver un mensaje que no
    // le ha llegado. Un aviso sin respuesta necesaria no abre ticket.
    const replyExpected = input.replyExpected !== false;
    const ticketId = replyExpected
      ? await this.openDirectTicket(tenantId, stored, meta.superAdminId)
      : null;
    const footer = ticketId
      ? `Puedes responder desde tu panel: ${this.webBaseUrl}/support/${ticketId}`
      : `Lo tienes también en tu panel, en Soporte → Mensajes de TrasterOS: ${this.webBaseUrl}/support?tab=trasteros`;
    const filesNote =
      files.length > 0
        ? `\n\nAdjuntos (descárgalos en tu panel, en Soporte → Mensajes de TrasterOS): ${files.map((f) => f.name).join(', ')}`
        : '';
    const { sent, failed } = await this.sendTo(
      recipients,
      input.subject,
      `${input.body}${filesNote}\n\n—\n${footer}`,
    );
    if (sent === 0) {
      if (ticketId) {
        await this.admin.supportTicket.delete({ where: { id: ticketId } }).catch(() => undefined);
      }
      throw new BadGatewayException({
        code: 'email_send_failed',
        message:
          'No se ha podido enviar el correo a ninguno de sus destinatarios. No se ha guardado nada; revisa «Correos enviados».',
      });
    }
    await this.recordDirectMessage(tenantId, ticketId, stored, meta.superAdminId, files);
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.email_sent',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { subject: input.subject, sent, failed, replyExpected, attachments: files.length },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    // Dejar constancia del email en el histórico de conversaciones del tenant
    // (best-effort: el email ya se envió, no rompemos la respuesta si falla).
    try {
      await this.interactions.create({
        tenantId,
        superAdminId: meta.superAdminId,
        input: { type: 'email', content: `Asunto: ${input.subject}\n\n${input.body}` },
      });
    } catch {
      /* el registro es secundario */
    }
    return { recipients: sent, failed };
  }

  /** Anuncio inmediato (Anuncios y acción masiva de Tenants): queda en el historial. */
  async broadcast(input: AdminBroadcastInput, meta: ActionMeta): Promise<AdminBroadcastResultDto> {
    const segment: AnnouncementSegment = {
      audience: input.audience,
      ...(input.tenantIds?.length ? { tenantIds: input.tenantIds } : {}),
      ...(input.tag && !input.tenantIds?.length ? { tag: input.tag } : {}),
    };
    const row = await this.admin.platformAnnouncement.create({
      data: {
        subject: input.subject,
        body: input.body,
        segment: segment as unknown as Prisma.InputJsonValue,
        commercial: input.commercial,
        status: 'sending',
        createdById: meta.superAdminId,
      },
      select: { id: true },
    });
    return this.deliverAnnouncement(row.id, meta);
  }

  /**
   * Envía un anuncio del historial: resuelve su público, encola un correo por
   * destinatario (con sus variables y, si es comercial, su enlace de baja), lo
   * deja en el panel de cada tenant y guarda los recuentos.
   */
  async deliverAnnouncement(
    announcementId: string,
    meta: ActionMeta,
    onlyRecipients?: Set<string>,
  ): Promise<AdminBroadcastResultDto> {
    // Un programado sin autor (borrado) sale sin autor.
    const actor = meta.superAdminId || null;
    const ann = await this.admin.platformAnnouncement.findUniqueOrThrow({
      where: { id: announcementId },
    });
    const segment = ann.segment as unknown as AnnouncementSegment;
    const selected = segment.tenantIds ?? [];
    const tenants = await this.segments.tenantsFor(segment);
    const recipients = await this.segments.recipientsFor(tenants, ann.commercial);

    const footer = `¿Dudas? Escríbenos desde Soporte en tu panel: ${this.webBaseUrl}/support`;
    const emails: QueuedEmail[] = [];
    const reached = new Set<string>();
    let optedOut = 0;
    for (const r of recipients) {
      if (onlyRecipients && !onlyRecipients.has(r.email)) continue;
      if (r.optedOut) {
        optedOut += 1;
        continue;
      }
      const vars = { empresa: r.tenantName, nombre: r.fullName };
      const subject = fillAdminMessageVariables(ann.subject, vars);
      const body = `${fillAdminMessageVariables(ann.body, vars)}\n\n—\n${footer}`;
      if (ann.commercial && r.userId) {
        const unsub = this.unsubscribeFooter(r.userId);
        emails.push({
          to: r.email,
          subject,
          ...renderAdminEmail(body, unsub),
          headers: unsub.headers,
          announcementId,
        });
      } else {
        emails.push({ to: r.email, subject, ...renderAdminEmail(body), announcementId });
      }
      reached.add(r.tenantId);
    }
    await this.enqueueRendered(emails);
    // Un reenvío no vuelve a dejarlo en el panel del tenant.
    if (!onlyRecipients) {
      const names = new Map(tenants.map((t) => [t.id, t.name]));
      for (const tenantId of reached) {
        const empresa = names.get(tenantId) ?? '';
        await this.recordBroadcast(
          [tenantId],
          {
            subject: fillAdminMessageVariables(ann.subject, { empresa }),
            body: fillAdminMessageVariables(ann.body, { empresa }),
          },
          actor,
        );
      }
    }
    const skipped = (selected.length > 0 ? selected.length : tenants.length) - reached.size;
    await this.admin.platformAnnouncement.update({
      where: { id: announcementId },
      data: onlyRecipients
        ? { recipientsCount: { increment: emails.length } }
        : {
            status: 'sent',
            sentAt: new Date(),
            tenantsCount: reached.size,
            recipientsCount: emails.length,
            optedOutCount: optedOut,
          },
    });

    await this.superAdminAudit.record({
      superAdminId: actor,
      action: onlyRecipients ? 'admin.broadcast_resent' : 'admin.broadcast_sent',
      targetType: 'platform',
      targetId: announcementId,
      targetTenantId: null,
      changes: {
        audience: selected.length > 0 ? 'selection' : segment.audience,
        ...(selected.length > 0 ? { selected: selected.length } : {}),
        segment: segment as unknown as Prisma.InputJsonValue,
        commercial: ann.commercial,
        subject: ann.subject,
        tenants: reached.size,
        recipients: emails.length,
        optedOut,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { tenants: reached.size, recipients: emails.length, failed: 0, skipped, optedOut };
  }

  /**
   * Playbook de retención en 1 clic (desde /admin/at-risk o /admin/health):
   * hace las 3 gestiones típicas a la vez sobre un tenant en riesgo:
   *   1) crea un **seguimiento** (dueDate = hoy + 3 días) para contactar,
   *   2) encola un **email de retención** a los owners verificados, y
   *   3) registra la gestión como una **interacción** (una sola).
   *
   * Orden y best-effort: el seguimiento y la interacción SIEMPRE se crean; el
   * email es best-effort — si el tenant no tiene owner verificado ni email de
   * facturación, se encolan 0 correos y el playbook NO falla (emailRecipients=0).
   *
   * DECISIÓN: NO reutilizamos `emailTenant` (que lanza `no_recipients` y crea su
   * propia interacción de tipo `email`), precisamente para (a) no romper el
   * best-effort sin destinatario y (b) no duplicar el registro — aquí dejamos
   * una única interacción `note` que resume el playbook. Sí reutilizamos las
   * primitivas internas `recipientsFor` + `enqueue` (misma cola BullMQ `email`).
   */
  async launchRetentionPlaybook(
    tenantId: string,
    superAdminId: string,
    meta: { note?: string | null; ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<RetentionPlaybookResultDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }

    // 1) Seguimiento a +3 días para que el equipo contacte al cliente.
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + 3);
    const dueDate = due.toISOString().slice(0, 10);
    const followup = await this.followups.create({
      tenantId,
      superAdminId,
      input: {
        title: 'Retención: contactar al cliente',
        dueDate,
        ...(meta.note ? { note: meta.note } : {}),
      },
    });

    // 2) Email de retención (best-effort: 0 destinatarios no rompe el playbook).
    const recipients = await this.recipientsFor(tenantId);
    const subject = '¿Podemos ayudarte con TrasterOS?';
    const body = [
      'Hola,',
      '',
      'Somos el equipo de TrasterOS. Queremos asegurarnos de que le estás sacando el máximo partido a la plataforma.',
      'Si hay algo que podamos mejorar, una duda que resolver o quieres que valoremos un descuento para que te siga saliendo a cuenta, estamos a tu disposición.',
      '',
      `Escríbenos desde Soporte en tu panel: ${this.webBaseUrl}/support`,
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    await this.enqueue(recipients, subject, body);
    const emailRecipients = recipients.length;
    await this.recordBroadcast([tenantId], { subject, body }, superAdminId, 'retention');

    // 3) Registro de la gestión como una única interacción.
    await this.interactions.create({
      tenantId,
      superAdminId,
      input: {
        type: 'note',
        content:
          `Playbook de retención lanzado: seguimiento creado (vence ${dueDate}) + ` +
          `email de retención encolado a ${emailRecipients} destinatario(s).` +
          (meta.note ? `\nNota: ${meta.note}` : ''),
      },
    });

    // 4) Auditoría (acción sensible → @RequireSuperadmin en el endpoint).
    await this.superAdminAudit.record({
      superAdminId,
      action: 'admin.tenant.retention_playbook',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { followupId: followup.id, emailRecipients, dueDate },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { followupId: followup.id, emailRecipients };
  }
}
