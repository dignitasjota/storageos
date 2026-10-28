import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { whatsappTextLanguage } from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { NO_PAYMENT_IN_FLIGHT } from '../../common/sepa-remittance-guard';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { SignaturesService } from '../move-in/signatures.service';

import { WhatsappCloudClient } from './whatsapp-cloud.client';

import type { Env } from '../../config/env.schema';

/** Mismos plazos que el recordatorio por correo (`BookingRecoveryService`). */
const MIN_AGE_MS = 12 * 60 * 60 * 1000;
const MIN_LEFT_MS = 6 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Recordatorio de las reservas preparadas por el asistente de WhatsApp que
 * siguen sin firmar o sin pagar: se envía por WhatsApp (texto si la ventana de
 * 24 h está abierta, si no la plantilla aprobada que configuró el tenant). Si
 * no se puede por WhatsApp, se deja para el correo de siempre. Una sola vez:
 * se reclama el mismo `contracts.booking_reminder_sent_at` que el correo (cada
 * recordatorio genera un enlace de firma nuevo e invalida el anterior).
 */
@Injectable()
export class WhatsappBookingRemindersService {
  private readonly logger = new Logger(WhatsappBookingRemindersService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly cloud: WhatsappCloudClient,
    private readonly signatures: SignaturesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async sendDue(now = new Date()): Promise<number> {
    const rows = await this.admin.whatsappConversation.findMany({
      where: {
        contractId: { not: null },
        bookingReminderSentAt: null,
        contract: {
          deletedAt: null,
          status: { in: ['draft', 'active'] },
          bookingReminderSentAt: null,
          firstPaymentDeadline: { gt: new Date(now.getTime() + MIN_LEFT_MS) },
          createdAt: { lte: new Date(now.getTime() - MIN_AGE_MS) },
          // Eligió transferencia, pago en el local o domiciliación: sin recordatorio.
          offlinePaymentMethod: null,
        },
      },
      select: { id: true },
      take: 200,
    });
    let sent = 0;
    for (const r of rows) {
      try {
        if (await this.remind(r.id, now)) sent += 1;
      } catch (err) {
        this.logger.warn(
          `whatsapp-reminder ${r.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent;
  }

  private async remind(conversationId: string, now: Date): Promise<boolean> {
    // La conversación se marca antes de nada: con varias réplicas, una sola la trata.
    const claimed = await this.admin.whatsappConversation.updateMany({
      where: { id: conversationId, bookingReminderSentAt: null },
      data: { bookingReminderSentAt: now },
    });
    if (claimed.count === 0) return false;
    const conv = await this.admin.whatsappConversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: {
        contract: {
          select: {
            id: true,
            status: true,
            signedAt: true,
            customer: { select: { firstName: true } },
            invoices: {
              // Un cobro en marcha (adeudo SEPA, remesa) no es «sin pagar».
              where: {
                status: { in: ['issued', 'overdue'] },
                kind: 'invoice',
                ...NO_PAYMENT_IN_FLIGHT,
              },
              select: { id: true },
              take: 1,
            },
          },
        },
        tenant: {
          select: {
            name: true,
            slug: true,
            customDomain: true,
            customDomainVerifiedAt: true,
            whatsappSettings: true,
          },
        },
      },
    });
    const contract = conv.contract;
    const settings = conv.tenant.whatsappSettings;
    if (!contract || !settings?.enabled) return false;
    const signed = contract.status === 'active' && !!contract.signedAt;
    if (signed && contract.invoices.length === 0) return false; // ya está pagada

    const windowOpen =
      !!conv.lastInboundAt && now.getTime() - conv.lastInboundAt.getTime() < WINDOW_MS;
    const template = settings.reminderTemplateName;
    // Sin forma de escribir por WhatsApp: lo hará el correo.
    if (!windowOpen && !template) return false;

    // Se reclama el recordatorio del contrato (el mismo que usa el correo).
    const claimContract = await this.admin.contract.updateMany({
      where: { id: contract.id, bookingReminderSentAt: null },
      data: { bookingReminderSentAt: now },
    });
    if (claimContract.count === 0) return false;

    const tenant = conv.tenant;
    const webBase = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    let url: string;
    if (!signed) {
      const { token } = await this.signatures.generateSigningToken(contract.id);
      const base =
        tenant.customDomain && tenant.customDomainVerifiedAt
          ? `https://${tenant.customDomain}`
          : webBase;
      url = `${base}/sign/${token}`;
    } else {
      url = tenantPortalLoginUrl(webBase, tenant);
    }
    const name = contract.customer.firstName?.trim() || conv.contactName?.split(' ')[0] || '';

    const accessToken = this.decrypt(settings.accessTokenEncrypted, settings.tenantId);
    if (!accessToken) return false;
    let body: string;
    let waMessageId: string | null = null;
    let error: string | null = null;
    try {
      if (windowOpen) {
        body =
          whatsappTextLanguage(conv.language) === 'en'
            ? `${name ? `Hi ${name}, ` : 'Hi, '}your storage unit is still reserved. ${
                signed
                  ? 'You only need to pay the first instalment to activate your access'
                  : 'You only need to sign the contract and pay'
              }: ${url}`
            : `${name ? `Hola ${name}, ` : 'Hola, '}tu trastero sigue reservado. ${
                signed
                  ? 'Solo te falta pagar la primera cuota para activar tu acceso'
                  : 'Solo te falta firmar el contrato y pagar'
              }: ${url}`;
        waMessageId = (
          await this.cloud.sendText({
            phoneNumberId: settings.phoneNumberId,
            accessToken,
            to: conv.waId,
            body,
          })
        ).messageId;
      } else {
        body = `Plantilla «${template}»: ${name || '—'} · ${url}`;
        waMessageId = (
          await this.cloud.sendTemplate({
            phoneNumberId: settings.phoneNumberId,
            accessToken,
            to: conv.waId,
            name: template!,
            language: settings.reminderTemplateLanguage,
            // {{1}} es el nombre: sin él, una palabra neutra (Meta no admite vacíos).
            params: [
              name || (whatsappTextLanguage(conv.language) === 'en' ? 'there' : 'cliente'),
              url,
            ],
          })
        ).messageId;
      }
    } catch (err) {
      body = `Recordatorio de la reserva: ${url}`;
      error = err instanceof Error ? err.message : 'No se pudo enviar';
    }
    await this.admin.whatsappMessage.create({
      data: {
        tenantId: settings.tenantId,
        conversationId: conv.id,
        direction: 'out',
        sender: 'assistant',
        body,
        waMessageId,
        status: error ? 'failed' : 'sent',
        error,
      },
    });
    if (error) {
      // No salió por WhatsApp: se libera para que lo mande el correo.
      await this.admin.contract.update({
        where: { id: contract.id },
        data: { bookingReminderSentAt: null },
      });
      return false;
    }
    await this.admin.whatsappConversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: now, lastMessagePreview: body.slice(0, 120) },
    });
    return true;
  }

  private decrypt(value: string, tenantId: string): string | null {
    try {
      return this.crypto.decryptString(value, tenantId);
    } catch {
      return null;
    }
  }
}
