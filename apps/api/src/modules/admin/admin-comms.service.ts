import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Env } from '../../config/env.schema';
import type {
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderEmail(body: string): { html: string; text: string } {
  const safe = escapeHtml(body).replace(/\n/g, '<br>');
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;line-height:1.6">${safe}</div>`;
  return { html, text: body };
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

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly superAdminAudit: SuperAdminAuditService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly followups: AdminTenantFollowupsService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true });
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
    const { html, text } = renderEmail(body);
    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      try {
        await this.email.sendRendered({ to, subject, html, text });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return { sent, failed };
  }

  /** Encola un email por destinatario en la cola BullMQ `email`. */
  private async enqueue(recipients: string[], subject: string, body: string): Promise<void> {
    if (recipients.length === 0) return;
    const { html, text } = renderEmail(body);
    await this.emailQueue.addBulk(
      recipients.map((to) => ({
        name: JOB_EMAIL_SEND,
        data: { to, subject, html, text },
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
    const { sent, failed } = await this.sendTo(recipients, input.subject, input.body);
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
    if (input.audience === 'active') where.status = 'active';
    else if (input.audience === 'trial') where.status = 'trial';
    else where.status = { in: ['active', 'trial'] };
    // Segmentación por etiqueta: AND con el público (mismo filtro que la lista).
    if (input.tag) where.tags = { has: input.tag };

    // Resolvemos los destinatarios de TODOS los tenants en 2 queries (no 2·N):
    // los tenants del público + sus owners verificados activos en bloque.
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
      select: { tenantId: true, email: true },
    });
    const ownersByTenant = new Map<string, Set<string>>();
    for (const o of owners) {
      const set = ownersByTenant.get(o.tenantId) ?? new Set<string>();
      set.add(o.email.toLowerCase());
      ownersByTenant.set(o.tenantId, set);
    }

    let reached = 0;
    const allRecipients: string[] = [];
    for (const t of tenants) {
      const set = ownersByTenant.get(t.id);
      const tos =
        set && set.size > 0 ? [...set] : t.billingEmail ? [t.billingEmail.toLowerCase()] : [];
      if (tos.length === 0) continue;
      reached += 1;
      allRecipients.push(...tos);
    }
    await this.enqueue(allRecipients, input.subject, input.body);

    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.broadcast_sent',
      targetType: 'platform',
      targetId: null,
      targetTenantId: null,
      changes: {
        audience: input.audience,
        tag: input.tag ?? null,
        subject: input.subject,
        tenants: reached,
        recipients: allRecipients.length,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { tenants: reached, recipients: allRecipients.length, failed: 0 };
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
      `Responde a este correo o escríbenos desde tu panel: ${this.webBaseUrl}/support`,
      '',
      'Un saludo,',
      'El equipo de TrasterOS',
    ].join('\n');
    await this.enqueue(recipients, subject, body);
    const emailRecipients = recipients.length;

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
