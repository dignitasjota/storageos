import { Injectable } from '@nestjs/common';

import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { WhatsappCloudClient, WhatsappCloudError } from './whatsapp-cloud.client';
import { WhatsappSettingsService } from './whatsapp-settings.service';

/** Un móvil en el formato de WhatsApp (un móvil español sin prefijo lleva el 34). */
export function whatsappId(phone: string | null | undefined): string | null {
  const digits = phone?.replace(/\D/g, '') ?? '';
  if (digits.length < 9) return null;
  return digits.length === 9 ? `34${digits}` : digits;
}

/**
 * Envío de una campaña por WhatsApp con una plantilla aprobada del número del
 * negocio. Cada mensaje queda en su conversación de la bandeja de WhatsApp.
 */
@Injectable()
export class WhatsappCampaignSender {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly settings: WhatsappSettingsService,
    private readonly cloud: WhatsappCloudClient,
  ) {}

  /** ¿Tiene el negocio WhatsApp Business activo? */
  async ready(tenantId: string): Promise<boolean> {
    if (!(await tenantHasFeature(this.admin, tenantId, 'whatsapp_business'))) return false;
    const settings = await this.settings.resolveForTenant(tenantId);
    return !!settings?.enabled;
  }

  async send(args: {
    tenantId: string;
    phone: string;
    contactName: string;
    customerId?: string;
    leadId?: string;
    template: { name: string; language: string };
    params: string[];
  }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
    const waId = whatsappId(args.phone);
    if (!waId) return { ok: false, error: 'El móvil no es válido' };
    const settings = await this.settings.resolveForTenant(args.tenantId);
    if (!settings?.enabled) return { ok: false, error: 'WhatsApp no está activo' };
    let messageId: string;
    try {
      messageId = (
        await this.cloud.sendTemplate({
          phoneNumberId: settings.phoneNumberId,
          accessToken: settings.accessToken,
          to: waId,
          name: args.template.name,
          language: args.template.language,
          params: args.params,
        })
      ).messageId;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof WhatsappCloudError ? err.message : 'No se pudo enviar la plantilla',
      };
    }
    const body = `Plantilla «${args.template.name}»${
      args.params.length > 0 ? `: ${args.params.join(' · ')}` : ''
    }`;
    const now = new Date();
    const conversation =
      (await this.admin.whatsappConversation.findUnique({
        where: { tenantId_waId: { tenantId: args.tenantId, waId } },
      })) ??
      (await this.admin.whatsappConversation.create({
        data: {
          tenantId: args.tenantId,
          waId,
          contactName: args.contactName,
          ...(args.customerId ? { customerId: args.customerId } : {}),
          ...(args.leadId ? { leadId: args.leadId } : {}),
        },
      }));
    await this.admin.whatsappMessage.create({
      data: {
        tenantId: args.tenantId,
        conversationId: conversation.id,
        direction: 'out',
        sender: 'staff',
        body,
        waMessageId: messageId,
        status: 'sent',
      },
    });
    await this.admin.whatsappConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now, lastMessagePreview: body.slice(0, 120) },
    });
    return { ok: true, messageId };
  }
}
