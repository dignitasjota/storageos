import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

import { messageIdVariants, type DeliveryEvent } from './email-events.parse';

/** Un aviso igual al super admin, como mucho cada 24 h. */
const SUPER_ADMIN_DEDUP_MS = 24 * 60 * 60 * 1000;

/**
 * Aplica los avisos de entrega de Brevo/Resend a las comunicaciones: Brevo y
 * Resend ACEPTAN un envío y lo rechazan o rebotan DESPUÉS (remitente sin
 * autenticar, buzón inexistente…). Sin esto, la comunicación se quedaba en
 * «enviado» para siempre y nadie se enteraba.
 *
 * - entregado → `delivered`;
 * - rebote permanente / bloqueado / email inválido → `bounced` + motivo;
 * - error del proveedor → `failed` + motivo;
 *   en ambos casos se avisa al equipo del tenant (notificación in-app).
 * - Rechazos de correos que no están en Comunicaciones (los de la plataforma,
 *   los de acceso al portal…) → aviso al super admin (deduplicado por motivo).
 */
@Injectable()
export class EmailEventsService {
  private readonly logger = new Logger(EmailEventsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
  ) {}

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
      select: { id: true, tenantId: true, recipient: true, customerId: true },
    });
    if (!comm) {
      if (e.outcome !== 'delivered') await this.notifySuperAdmin(e);
      return false;
    }

    if (e.outcome === 'delivered') {
      await this.admin.communication.updateMany({
        where: { id: comm.id, status: 'sent' },
        data: { status: 'delivered', deliveredAt: e.occurredAt },
      });
      return true;
    }

    const updated = await this.admin.communication.updateMany({
      where: { id: comm.id, status: { in: ['processing', 'sent', 'delivered'] } },
      data: {
        status: e.outcome === 'bounced' ? 'bounced' : 'failed',
        failedAt: e.occurredAt,
        errorMessage: e.reason,
      },
    });
    if (updated.count > 0) {
      await this.notifications.create(comm.tenantId, {
        type: 'communication.undelivered',
        title: `No se pudo entregar un correo a ${comm.recipient}`,
        ...(e.reason ? { body: e.reason } : {}),
        link: comm.customerId ? `/customers/${comm.customerId}` : '/communications',
      });
    }
    return true;
  }

  private async notifySuperAdmin(e: DeliveryEvent): Promise<void> {
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
        link: '/admin/email',
      },
    });
  }
}
