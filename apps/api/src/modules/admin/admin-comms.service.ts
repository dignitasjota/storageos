import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import { renderAdminEmail } from '@storageos/shared';
import { Queue } from 'bullmq';

import { buildUnsubscribeToken, unsubscribeKey } from '../../common/marketing/unsubscribe-token';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

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
    const owners = await this.admin.user.findMany({
      where: { tenantId, role: 'owner', isActive: true, emailVerifiedAt: { not: null } },
      select: { email: true },
    });
    const emails = new Set(owners.map((o) => o.email.toLowerCase()));
    if (emails.size === 0) {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { billingEmail: true },
      });
      if (tenant?.billingEmail) emails.add(tenant.billingEmail.toLowerCase());
    }
    return [...emails];
  }

  private async sendTo(
    recipients: string[],
    subject: string,
    body: string,
  ): Promise<{ sent: number; failed: number }> {
    const { html, text } = renderAdminEmail(body);
    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      try {
        const result = await this.email.sendRendered({
          to,
          kind: 'admin_message',
          subject,
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
    ticketId: string,
    input: { subject: string; body: string },
    superAdminId: string,
  ): Promise<void> {
    await this.admin.tenantPlatformMessage.create({
      data: {
        tenantId,
        kind: 'direct',
        subject: input.subject,
        body: input.body,
        ticketId,
        superAdminId,
      },
    });
    await this.notifications
      .create(tenantId, {
        type: 'platform.message',
        title: `Mensaje de TrasterOS: ${input.subject}`,
        body: input.body.slice(0, 140),
        link: `/support/${ticketId}`,
      })
      .catch(() => undefined);
  }

  /** Anuncio o correo de retención: queda en el panel de cada tenant y le avisa. */
  private async recordBroadcast(
    tenantIds: string[],
    input: { subject: string; body: string },
    superAdminId: string,
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
      data: tenantIds.map((tenantId) => ({
        tenantId,
        type: 'platform.message',
        title: `Mensaje de TrasterOS: ${input.subject}`,
        body: input.body.slice(0, 140),
        link: '/support?tab=trasteros',
      })),
    });
  }

  /** Mensajes de TrasterOS al tenant (cara tenant, Soporte), de 30 en 30. */
  async listForTenant(tenantId: string, cursor?: string): Promise<TenantPlatformMessagesPageDto> {
    const take = 30;
    const [rows, unread] = await Promise.all([
      this.admin.tenantPlatformMessage.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      this.admin.tenantPlatformMessage.count({ where: { tenantId, readAt: null } }),
    ]);
    const page = rows.slice(0, take);
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind as TenantPlatformMessageDto['kind'],
        subject: r.subject,
        body: r.body,
        ticketId: r.ticketId,
        readAt: r.readAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      unread,
    };
  }

  /** El tenant abre la pestaña: todo queda leído. */
  async markReadForTenant(tenantId: string): Promise<void> {
    await this.admin.tenantPlatformMessage.updateMany({
      where: { tenantId, readAt: null },
      data: { readAt: new Date() },
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
    const recipients = await this.recipientsFor(tenantId);
    if (recipients.length === 0) {
      throw new BadRequestException({
        code: 'no_recipients',
        message: 'El tenant no tiene destinatarios (owner verificado o email de facturación).',
      });
    }
    // El ticket hace falta antes de enviar (el correo lleva su enlace). Si el
    // correo no sale a nadie, se borra: el tenant no debe ver un mensaje que no
    // le ha llegado.
    const ticketId = await this.openDirectTicket(tenantId, input, meta.superAdminId);
    const replyUrl = `${this.webBaseUrl}/support/${ticketId}`;
    const { sent, failed } = await this.sendTo(
      recipients,
      input.subject,
      `${input.body}\n\n—\nPuedes responder desde tu panel: ${replyUrl}`,
    );
    if (sent === 0) {
      await this.admin.supportTicket.delete({ where: { id: ticketId } }).catch(() => undefined);
      throw new BadGatewayException({
        code: 'email_send_failed',
        message:
          'No se ha podido enviar el correo a ninguno de sus destinatarios. No se ha guardado nada; revisa «Correos enviados».',
      });
    }
    await this.recordDirectMessage(tenantId, ticketId, input, meta.superAdminId);
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.email_sent',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { subject: input.subject, sent, failed },
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

  async broadcast(input: AdminBroadcastInput, meta: ActionMeta): Promise<AdminBroadcastResultDto> {
    const where: Prisma.TenantWhereInput = { deletedAt: null };
    const selected = input.tenantIds ?? [];
    const selection = selected.length > 0;
    if (selection) {
      // Selección concreta desde la lista: también suspendidos, nunca los dados de baja.
      where.id = { in: selected };
      where.status = { not: 'cancelled' };
    } else {
      if (input.audience === 'active') where.status = 'active';
      else if (input.audience === 'trial') where.status = 'trial';
      else where.status = { in: ['active', 'trial'] };
      // Segmentación por etiqueta: AND con el público (mismo filtro que la lista).
      if (input.tag) where.tags = { has: input.tag };
    }

    // Destinatarios de TODOS los tenants en 2 consultas (no 2·N).
    const tenants = await this.admin.tenant.findMany({
      where,
      select: { id: true, billingEmail: true },
    });
    const owners = await this.admin.user.findMany({
      where: {
        tenantId: { in: tenants.map((t) => t.id) },
        role: 'owner',
        isActive: true,
        emailVerifiedAt: { not: null },
      },
      select: { id: true, tenantId: true, email: true, platformNewsOptOutAt: true },
    });
    const ownersByTenant = new Map<string, typeof owners>();
    for (const o of owners) {
      const list = ownersByTenant.get(o.tenantId) ?? [];
      list.push(o);
      ownersByTenant.set(o.tenantId, list);
    }

    const footer = `¿Dudas? Escríbenos desde Soporte en tu panel: ${this.webBaseUrl}/support`;
    const body = `${input.body}\n\n—\n${footer}`;
    const plain = renderAdminEmail(body);
    const emails: QueuedEmail[] = [];
    const reachedIds: string[] = [];
    let optedOut = 0;
    for (const t of tenants) {
      const tenantOwners = ownersByTenant.get(t.id) ?? [];
      const seen = new Set<string>();
      const before = emails.length;
      if (input.commercial) {
        // Comercial: solo a usuarios (cada uno con su enlace de baja).
        for (const o of tenantOwners) {
          const email = o.email.toLowerCase();
          if (seen.has(email)) continue;
          seen.add(email);
          if (o.platformNewsOptOutAt) {
            optedOut += 1;
            continue;
          }
          const unsub = this.unsubscribeFooter(o.id);
          const rendered = renderAdminEmail(body, unsub);
          emails.push({ to: email, subject: input.subject, ...rendered, headers: unsub.headers });
        }
      } else {
        for (const o of tenantOwners) seen.add(o.email.toLowerCase());
        if (seen.size === 0 && t.billingEmail) seen.add(t.billingEmail.toLowerCase());
        for (const to of seen) emails.push({ to, subject: input.subject, ...plain });
      }
      if (emails.length > before) reachedIds.push(t.id);
    }
    await this.enqueueRendered(emails);
    await this.recordBroadcast(reachedIds, input, meta.superAdminId);

    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.broadcast_sent',
      targetType: 'platform',
      targetId: null,
      targetTenantId: null,
      changes: {
        audience: selection ? 'selection' : input.audience,
        ...(selection ? { selected: selected.length } : {}),
        tag: selection ? null : (input.tag ?? null),
        commercial: input.commercial,
        subject: input.subject,
        tenants: reachedIds.length,
        recipients: emails.length,
        optedOut,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return {
      tenants: reachedIds.length,
      recipients: emails.length,
      failed: 0,
      // Elegidos que no reciben nada: sin destinatario, de baja o dados de baja del servicio.
      skipped: (selection ? selected.length : tenants.length) - reachedIds.length,
      optedOut,
    };
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
