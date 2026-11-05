import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { tenantHasFeature } from '../../common/tenant-features';
import { DOMAIN_EVENTS, type WaitlistNotifiedPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { WhatsappCloudClient } from './whatsapp-cloud.client';
import { WhatsappSettingsService } from './whatsapp-settings.service';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Aviso de la lista de espera también por WhatsApp, si el negocio tiene el extra:
 * texto con la ventana de 24 h abierta y, si no, la plantilla de recordatorio
 * ({{1}} nombre, {{2}} enlace). El correo sale siempre; esto es un extra.
 */
@Injectable()
export class WhatsappWaitlistService {
  private readonly logger = new Logger(WhatsappWaitlistService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly settings: WhatsappSettingsService,
    private readonly cloud: WhatsappCloudClient,
  ) {}

  @OnEvent(DOMAIN_EVENTS.waitlist_notified, { async: true, promisify: true })
  async onNotified(p: WaitlistNotifiedPayload): Promise<void> {
    try {
      await this.send(p);
    } catch (err) {
      this.logger.warn(`[whatsapp] aviso de la cola sin enviar: ${(err as Error).message}`);
    }
  }

  private async send(p: WaitlistNotifiedPayload): Promise<void> {
    const digits = p.phone?.replace(/\D/g, '') ?? '';
    if (digits.length < 9) return;
    if (!(await tenantHasFeature(this.admin, p.tenantId, 'whatsapp_business'))) return;
    const settings = await this.settings.resolveForTenant(p.tenantId);
    if (!settings?.enabled) return;
    const row = await this.admin.tenantWhatsappSettings.findUnique({
      where: { tenantId: p.tenantId },
      select: { reminderTemplateName: true, reminderTemplateLanguage: true },
    });
    // Un móvil español sin prefijo.
    const waId = digits.length === 9 ? `34${digits}` : digits;
    const existing = await this.admin.whatsappConversation.findUnique({
      where: { tenantId_waId: { tenantId: p.tenantId, waId } },
    });
    const now = new Date();
    const windowOpen =
      !!existing?.lastInboundAt && now.getTime() - existing.lastInboundAt.getTime() < WINDOW_MS;
    if (!windowOpen && !row?.reminderTemplateName) return;

    const name = p.contactName.split(' ')[0] || 'cliente';
    let body: string;
    let waMessageId: string;
    if (windowOpen) {
      body = `Hola ${name}, se ha liberado un ${p.unitTypeName} en ${p.facilityName}. Te lo guardamos ${p.hours} horas: ${p.link}`;
      waMessageId = (
        await this.cloud.sendText({
          phoneNumberId: settings.phoneNumberId,
          accessToken: settings.accessToken,
          to: waId,
          body,
        })
      ).messageId;
    } else {
      body = `Plantilla «${row!.reminderTemplateName}»: ${name} · ${p.link}`;
      waMessageId = (
        await this.cloud.sendTemplate({
          phoneNumberId: settings.phoneNumberId,
          accessToken: settings.accessToken,
          to: waId,
          name: row!.reminderTemplateName!,
          language: row!.reminderTemplateLanguage,
          params: [name, p.link],
        })
      ).messageId;
    }
    const conversation =
      existing ??
      (await this.admin.whatsappConversation.create({
        data: { tenantId: p.tenantId, waId, contactName: p.contactName },
      }));
    await this.admin.whatsappMessage.create({
      data: {
        tenantId: p.tenantId,
        conversationId: conversation.id,
        direction: 'out',
        sender: 'assistant',
        body,
        waMessageId,
        status: 'sent',
      },
    });
    await this.admin.whatsappConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now, lastMessagePreview: body.slice(0, 120) },
    });
  }
}
