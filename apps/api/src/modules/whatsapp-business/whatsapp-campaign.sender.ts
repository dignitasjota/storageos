import { Injectable } from '@nestjs/common';
import { WHATSAPP_SERVICE_WINDOW_HOURS } from '@storageos/shared';

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

  /**
   * Aviso a un inquilino (p. ej. un recordatorio de impago): dentro de las 24 h
   * desde su último mensaje, como texto; fuera, con la plantilla de Meta si la
   * hay. Sin plantilla y con la ventana cerrada no sale nada (`skipped`).
   * Queda en la conversación de la bandeja de WhatsApp.
   */
  async sendNotice(args: {
    tenantId: string;
    phone: string;
    contactName: string;
    customerId?: string;
    text: string;
    template: { name: string; language: string; params: string[] } | null;
  }): Promise<
    | { ok: true; messageId: string; via: 'text' | 'template'; body: string; waId: string }
    | { ok: false; skipped: boolean; error: string; waId: string | null }
  > {
    const waId = whatsappId(args.phone);
    if (!waId) return { ok: false, skipped: true, error: 'El móvil no es válido', waId: null };
    const settings = await this.settings.resolveForTenant(args.tenantId);
    if (!settings?.enabled) {
      return { ok: false, skipped: true, error: 'WhatsApp no está activo', waId };
    }
    const existing = await this.admin.whatsappConversation.findUnique({
      where: { tenantId_waId: { tenantId: args.tenantId, waId } },
    });
    const windowOpen =
      !!existing?.lastInboundAt &&
      Date.now() - existing.lastInboundAt.getTime() < WHATSAPP_SERVICE_WINDOW_HOURS * 3_600_000;
    if (!windowOpen && !args.template) {
      return {
        ok: false,
        skipped: true,
        error: `Han pasado más de ${WHATSAPP_SERVICE_WINDOW_HOURS} h desde su último mensaje y no hay plantilla de Meta para el recordatorio`,
        waId,
      };
    }
    let messageId: string;
    let body: string;
    try {
      if (windowOpen) {
        body = args.text;
        messageId = (
          await this.cloud.sendText({
            phoneNumberId: settings.phoneNumberId,
            accessToken: settings.accessToken,
            to: waId,
            body,
          })
        ).messageId;
      } else {
        const t = args.template!;
        body = `Plantilla «${t.name}»${t.params.length > 0 ? `: ${t.params.join(' · ')}` : ''}`;
        messageId = (
          await this.cloud.sendTemplate({
            phoneNumberId: settings.phoneNumberId,
            accessToken: settings.accessToken,
            to: waId,
            name: t.name,
            language: t.language,
            params: t.params,
          })
        ).messageId;
      }
    } catch (err) {
      return {
        ok: false,
        skipped: false,
        error: err instanceof WhatsappCloudError ? err.message : 'No se pudo enviar el WhatsApp',
        waId,
      };
    }
    const now = new Date();
    const conversation =
      existing ??
      (await this.admin.whatsappConversation.create({
        data: {
          tenantId: args.tenantId,
          waId,
          contactName: args.contactName,
          ...(args.customerId ? { customerId: args.customerId } : {}),
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
    return { ok: true, messageId, via: windowOpen ? 'text' : 'template', body, waId };
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
