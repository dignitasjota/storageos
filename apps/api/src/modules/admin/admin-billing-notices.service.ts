import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BILLING_NOTICE_COOLDOWN_DAYS,
  BILLING_NOTICE_LABELS,
  buildBillingNotice,
  fillAdminMessageVariables,
  renderAdminEmail,
  type BillingNoticeContext,
  type BillingNoticeKind,
  type BillingNoticePreviewDto,
} from '@storageos/shared';

import { HoldedSyncService } from '../accounting/holded-sync.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';

import { AdminSegmentService } from './admin-segment.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { markAlertSent } from './alert-state';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { BillingActionMeta } from './admin-billing-ops-health.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function fmtDate(d: Date): string {
  return d.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
}

/**
 * Avisos al tenant por un problema de facturación, con el correo ya redactado,
 * vista previa y enfriamiento de 7 días por tenant y problema. Cada aviso queda
 * en el historial del tenant (interacción) y en el registro de acciones.
 */
@Injectable()
export class AdminBillingNoticesService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly segments: AdminSegmentService,
    private readonly email: EmailService,
    private readonly holded: HoldedSyncService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  private stateKind(kind: BillingNoticeKind): string {
    return `billing_notice:${kind}`;
  }

  /** Cuándo se avisó por última vez (null = nunca). */
  private async lastSent(tenantId: string, kind: BillingNoticeKind): Promise<Date | null> {
    const rows = await this.admin.$queryRaw<Array<{ last_sent_at: Date }>>`
      SELECT last_sent_at FROM security_alert_states
      WHERE kind = ${this.stateKind(kind)} AND identifier = ${tenantId}`;
    return rows[0]?.last_sent_at ?? null;
  }

  /** Datos del correo; 400 si el problema ya no se da. */
  private async context(
    tenantId: string,
    kind: BillingNoticeKind,
    credentialId?: string,
  ): Promise<BillingNoticeContext> {
    const tenant = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { name: true, verifactuEnabled: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const notApplicable = (message: string) =>
      new BadRequestException({ code: 'notice_not_applicable', message });
    const now = new Date();
    switch (kind) {
      case 'certificate_expiring': {
        const cred = await this.admin.tenantAeatCredential.findFirst({
          where: { tenantId, revokedAt: null, ...(credentialId ? { id: credentialId } : {}) },
          orderBy: { certValidTo: 'asc' },
          select: { certValidTo: true, owner: { select: { legalName: true } } },
        });
        if (!cred) throw notApplicable('Este tenant no tiene certificado vigente.');
        const daysLeft = Math.ceil((cred.certValidTo.getTime() - now.getTime()) / DAY_MS);
        if (daysLeft > 60) throw notApplicable('El certificado no caduca en los próximos 60 días.');
        return {
          tenantName: tenant.name,
          daysLeft,
          validTo: fmtDate(cred.certValidTo),
          ownerName: cred.owner?.legalName ?? null,
        };
      }
      case 'certificate_missing': {
        const count = await this.admin.tenantAeatCredential.count({
          where: { tenantId, revokedAt: null, certValidTo: { gt: now } },
        });
        if (!tenant.verifactuEnabled || count > 0) {
          throw notApplicable('Este tenant tiene un certificado vigente o no usa Veri*Factu.');
        }
        return { tenantName: tenant.name };
      }
      case 'invoice_rejected': {
        const [count, example] = await Promise.all([
          this.admin.invoice.count({
            where: { tenantId, deletedAt: null, aeatStatus: 'rejected' },
          }),
          this.admin.invoice.findFirst({
            where: { tenantId, deletedAt: null, aeatStatus: 'rejected' },
            orderBy: { id: 'desc' },
            select: { invoiceNumber: true, aeatResponse: true },
          }),
        ]);
        if (count === 0) throw notApplicable('Este tenant no tiene facturas rechazadas.');
        const resp = example?.aeatResponse as { message?: string } | null;
        return {
          tenantName: tenant.name,
          count,
          exampleNumber: example?.invoiceNumber ?? null,
          exampleMessage: resp?.message?.slice(0, 200) ?? null,
        };
      }
      case 'holded_review': {
        const reviewCount = await this.holded.reviewCount(tenantId);
        if (reviewCount === 0) throw notApplicable('No hay envíos a Holded para revisar.');
        return { tenantName: tenant.name, reviewCount };
      }
    }
  }

  async preview(
    tenantId: string,
    kind: BillingNoticeKind,
    message?: string,
    credentialId?: string,
  ): Promise<BillingNoticePreviewDto> {
    const ctx = await this.context(tenantId, kind, credentialId);
    const notice = buildBillingNotice(kind, ctx, message);
    const [recipients, last] = await Promise.all([
      this.recipients(tenantId),
      this.lastSent(tenantId, kind),
    ]);
    const until = last ? new Date(last.getTime() + BILLING_NOTICE_COOLDOWN_DAYS * DAY_MS) : null;
    return {
      kind,
      subject: notice.subject,
      body: notice.body,
      recipients: recipients.map((r) => r.email),
      cooldownUntil: until && until > new Date() ? until.toISOString() : null,
    };
  }

  private async recipients(tenantId: string) {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, billingEmail: true },
    });
    return tenant ? this.segments.recipientsFor([tenant], false) : [];
  }

  async send(
    tenantId: string,
    kind: BillingNoticeKind,
    opts: { message?: string | undefined; credentialId?: string | undefined },
    meta: BillingActionMeta,
  ): Promise<{ sent: number; failed: number }> {
    const ctx = await this.context(tenantId, kind, opts.credentialId);
    const last = await this.lastSent(tenantId, kind);
    if (last && Date.now() - last.getTime() < BILLING_NOTICE_COOLDOWN_DAYS * DAY_MS) {
      throw new ConflictException({
        code: 'notice_cooldown',
        message: `Ya se le avisó de esto el ${fmtDate(last)}. Hasta pasados ${BILLING_NOTICE_COOLDOWN_DAYS} días no se puede repetir.`,
        details: {
          until: new Date(last.getTime() + BILLING_NOTICE_COOLDOWN_DAYS * DAY_MS).toISOString(),
        },
      });
    }
    const recipients = await this.recipients(tenantId);
    if (recipients.length === 0) {
      throw new BadRequestException({
        code: 'no_recipients',
        message: 'El tenant no tiene ningún propietario con el email verificado',
      });
    }
    const notice = buildBillingNotice(kind, ctx, opts.message);
    let sent = 0;
    let failed = 0;
    for (const r of recipients) {
      const vars = { empresa: r.tenantName, nombre: r.fullName };
      const { html, text } = renderAdminEmail(fillAdminMessageVariables(notice.body, vars));
      try {
        const res = await this.email.sendRendered({
          to: r.email,
          kind: 'admin_message',
          subject: fillAdminMessageVariables(notice.subject, vars),
          html,
          text,
        });
        if (res.suppressed) failed += 1;
        else sent += 1;
      } catch {
        failed += 1;
      }
    }
    if (sent === 0) {
      throw new BadRequestException({
        code: 'email_send_failed',
        message: 'No se ha podido enviar el correo (direcciones bloqueadas o error de envío)',
      });
    }
    await markAlertSent(this.admin, this.stateKind(kind), tenantId);
    await this.interactions
      .create({
        tenantId,
        superAdminId: meta.superAdminId,
        input: {
          type: 'email',
          content: `${notice.subject}\n\n(Aviso de facturación «${BILLING_NOTICE_LABELS[kind]}» enviado a ${recipients.map((r) => r.email).join(', ')})`,
        },
      })
      .catch(() => undefined);
    await this.audit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.billing.notice_sent',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { kind, sent, failed },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { sent, failed };
  }
}
