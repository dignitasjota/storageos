import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type {
  AdminBroadcastInput,
  AdminBroadcastResultDto,
  AdminEmailTenantInput,
  AdminEmailTenantResultDto,
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
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly superAdminAudit: SuperAdminAuditService,
  ) {}

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

  /** Envío "fire-and-forget" en segundo plano (no bloquea el request HTTP). */
  private sendInBackground(recipients: string[], subject: string, body: string): void {
    const { html, text } = renderEmail(body);
    void (async () => {
      for (const to of recipients) {
        try {
          await this.email.sendRendered({ to, subject, html, text });
        } catch {
          // Best-effort: el fallo de un destinatario no afecta al resto.
        }
      }
    })();
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
    return { recipients: sent, failed };
  }

  async broadcast(input: AdminBroadcastInput, meta: ActionMeta): Promise<AdminBroadcastResultDto> {
    const where: Prisma.TenantWhereInput = { deletedAt: null };
    if (input.audience === 'active') where.status = 'active';
    else if (input.audience === 'trial') where.status = 'trial';
    else where.status = { in: ['active', 'trial'] };
    const tenants = await this.admin.tenant.findMany({ where, select: { id: true } });

    // Resolvemos los destinatarios (queries rápidas) y disparamos el envío en
    // segundo plano: un broadcast masivo no debe bloquear el request HTTP.
    let reached = 0;
    const allRecipients: string[] = [];
    for (const t of tenants) {
      const tos = await this.recipientsFor(t.id);
      if (tos.length === 0) continue;
      reached += 1;
      allRecipients.push(...tos);
    }
    this.sendInBackground(allRecipients, input.subject, input.body);

    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.broadcast_sent',
      targetType: 'platform',
      targetId: null,
      targetTenantId: null,
      changes: {
        audience: input.audience,
        subject: input.subject,
        tenants: reached,
        recipients: allRecipients.length,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { tenants: reached, recipients: allRecipients.length, failed: 0 };
  }
}
