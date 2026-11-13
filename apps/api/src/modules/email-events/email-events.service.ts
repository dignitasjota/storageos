import { Injectable, Logger } from '@nestjs/common';
import { suggestEmailFix } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailSuppressionsService } from '../email/email-suppressions.service';
import { PlatformEmailLogService } from '../email/platform-email-log.service';
import { NotificationsService } from '../notifications/notifications.service';

import { SOFT_BOUNCE_PREFIX, messageIdVariants, type DeliveryEvent } from './email-events.parse';

/** Un aviso igual al super admin, como mucho cada 24 h. */
const SUPER_ADMIN_DEDUP_MS = 24 * 60 * 60 * 1000;

/**
 * Aplica los avisos de entrega de Brevo/Resend a las comunicaciones: Brevo y
 * Resend ACEPTAN un envío y lo rechazan o rebotan DESPUÉS (remitente sin
 * autenticar, buzón inexistente…). Sin esto, la comunicación se quedaba en
 * «enviado» para siempre y nadie se enteraba.
 *
 * - entregado → `delivered` (también tras un rebote temporal: el reintento llegó);
 * - rebote permanente / bloqueado / email inválido → `bounced` + motivo;
 * - rebote temporal → `bounced` con «Rebote temporal: …» (el proveedor lo sigue
 *   intentando; no bloquea la dirección) y aviso al equipo, con la dirección
 *   corregida si parece mal escrita (`@gmial.com`);
 * - error del proveedor → `failed` + motivo;
 *   en ambos casos se avisa al equipo del tenant (notificación in-app).
 * - Rechazos de correos que no están en Comunicaciones (los de la plataforma,
 *   los de acceso al portal…) → aviso al super admin (deduplicado por motivo).
 * - Lista de supresión: un rebote permanente (o dirección inválida/bloqueada)
 *   bloquea la dirección para todo; una queja de spam da de baja comercial al
 *   destinatario en ese tenant.
 */
@Injectable()
export class EmailEventsService {
  private readonly logger = new Logger(EmailEventsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
    private readonly suppressions: EmailSuppressionsService,
    private readonly platformLog: PlatformEmailLogService,
  ) {}

  /**
   * Anota que ha llegado un aviso del proveedor (Correo saliente enseña el
   * último): así se sabe si el webhook está conectado. Como mucho una
   * escritura por minuto.
   */
  async markReceived(provider: 'brevo' | 'resend'): Promise<void> {
    const field = provider === 'brevo' ? 'brevoEventsLastAt' : 'resendEventsLastAt';
    const now = new Date();
    try {
      const updated = await this.admin.platformEmailSettings.updateMany({
        where: {
          OR: [{ [field]: null }, { [field]: { lt: new Date(now.getTime() - 60_000) } }],
        },
        data: { [field]: now },
      });
      if (updated.count === 0 && !(await this.admin.platformEmailSettings.findFirst())) {
        await this.admin.platformEmailSettings.create({ data: { [field]: now } });
      }
    } catch (err) {
      this.logger.warn(`[email-events] no se pudo anotar el aviso: ${(err as Error).message}`);
    }
  }

  async apply(events: DeliveryEvent[]): Promise<{ matched: number }> {
    let matched = 0;
    for (const e of events) {
      try {
        if (await this.applyOne(e)) matched++;
      } catch (err) {
        this.logger.warn(
          `[email-events] ${e.provider} ${e.messageId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { matched };
  }

  private async applyOne(e: DeliveryEvent): Promise<boolean> {
    const comm = await this.admin.communication.findFirst({
      where: { providerMessageId: { in: messageIdVariants(e.messageId) }, channel: 'email' },
      select: {
        id: true,
        tenantId: true,
        recipient: true,
        customerId: true,
        leadId: true,
        contractId: true,
        invoiceId: true,
      },
    });
    const recipient = e.recipient ?? comm?.recipient ?? null;

    if (e.outcome === 'complained') {
      await this.applyComplaint(e, comm, recipient);
      return !!comm;
    }
    if (e.suppressReason && recipient) {
      await this.suppressions.suppress({
        email: recipient,
        tenantId: null,
        scope: 'all',
        reason: e.suppressReason,
        provider: e.provider,
        detail: e.reason,
      });
    }

    if (!comm) {
      // Correo de la plataforma (verificación, facturas de la suscripción…):
      // se actualiza su historial.
      const platform = await this.platformLog.applyDelivery(messageIdVariants(e.messageId), e);
      // Un rebote temporal se reintenta: el super admin solo se entera de los definitivos.
      if (e.outcome !== 'delivered' && e.outcome !== 'soft_bounced') {
        await this.notifySuperAdmin(e, platform);
      }
      return platform;
    }

    const softBounced = {
      status: 'bounced' as const,
      errorMessage: { startsWith: SOFT_BOUNCE_PREFIX },
    };
    if (e.outcome === 'delivered') {
      await this.admin.communication.updateMany({
        where: { id: comm.id, OR: [{ status: 'sent' }, softBounced] },
        data: {
          status: 'delivered',
          deliveredAt: e.occurredAt,
          failedAt: null,
          errorMessage: null,
        },
      });
      return true;
    }

    const data = {
      status: e.outcome === 'failed' ? ('failed' as const) : ('bounced' as const),
      failedAt: e.occurredAt,
      errorMessage: e.reason,
    };
    const updated = await this.admin.communication.updateMany({
      where: { id: comm.id, status: { in: ['processing', 'sent', 'delivered'] } },
      data,
    });
    if (updated.count === 0) {
      // Tras un rebote temporal llega el definitivo: se cambia el motivo, sin
      // volver a avisar.
      if (e.outcome !== 'soft_bounced') {
        await this.admin.communication.updateMany({ where: { id: comm.id, ...softBounced }, data });
      }
      return true;
    }
    const suggestion = suggestEmailFix(comm.recipient);
    const hint = suggestion
      ? `¿Está bien escrito? Quizá sea ${suggestion}.`
      : e.outcome === 'soft_bounced'
        ? 'Se seguirá intentando unas horas; si no llega, comprueba su email.'
        : null;
    const body = [e.reason, hint].filter(Boolean).join(' · ');
    await this.notifications.create(comm.tenantId, {
      type: 'communication.undelivered',
      title:
        e.outcome === 'soft_bounced'
          ? `No le está llegando un correo a ${comm.recipient}`
          : `No se pudo entregar un correo a ${comm.recipient}`,
      ...(body ? { body } : {}),
      link: comm.customerId ? `/customers/${comm.customerId}` : '/communications',
      contractId: comm.contractId,
      invoiceId: comm.invoiceId,
    });
    return true;
  }

  /**
   * Queja de spam: el destinatario no recibe más comunicaciones comerciales de
   * ese tenant (los correos necesarios —facturas, accesos— siguen saliendo).
   */
  private async applyComplaint(
    e: DeliveryEvent,
    comm: { tenantId: string; customerId: string | null; leadId: string | null } | null,
    recipient: string | null,
  ): Promise<void> {
    if (!recipient) return;
    await this.suppressions.suppress({
      email: recipient,
      tenantId: comm?.tenantId ?? null,
      scope: 'marketing',
      reason: 'complaint',
      provider: e.provider,
      detail: e.reason,
    });
    if (!comm) return;
    const now = new Date();
    if (comm.customerId) {
      await this.admin.customer.updateMany({
        where: { id: comm.customerId, marketingOptOutAt: null },
        data: { marketingOptOutAt: now },
      });
    }
    if (comm.leadId) {
      await this.admin.lead.updateMany({
        where: { id: comm.leadId, marketingOptOutAt: null },
        data: { marketingOptOutAt: now },
      });
    }
    await this.notifications.create(comm.tenantId, {
      type: 'communication.complaint',
      title: `${recipient} marcó un correo como spam`,
      body: 'Ya no recibirá campañas ni ofertas. Los correos de su contrato siguen saliendo.',
      link: comm.customerId ? `/customers/${comm.customerId}` : '/communications',
    });
  }

  private async notifySuperAdmin(e: DeliveryEvent, inPlatformLog = false): Promise<void> {
    const provider = e.provider === 'brevo' ? 'Brevo' : 'Resend';
    const body = e.reason ?? 'Sin motivo indicado';
    const recent = await this.admin.superAdminNotification.findFirst({
      where: {
        type: 'email.provider_rejected',
        body,
        createdAt: { gte: new Date(Date.now() - SUPER_ADMIN_DEDUP_MS) },
      },
      select: { id: true },
    });
    if (recent) return;
    await this.admin.superAdminNotification.create({
      data: {
        type: 'email.provider_rejected',
        title: `${provider} no entregó un correo${e.recipient ? ` a ${e.recipient}` : ''}`,
        body,
        link: inPlatformLog ? '/admin/email-log' : '/admin/email',
      },
    });
  }
}
