import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MIME_TYPES,
  MESSAGE_MAX_ATTACHMENTS,
  parseReplyAddress,
  stripQuotedReply,
  type EmailInboundInput,
  type MessageAttachmentInput,
} from '@storageos/shared';

import { claimAlert } from '../admin/alert-state';
import { SupportTicketsService } from '../admin/support-tickets.service';
import { CustomerMessagesService } from '../customer-messages/customer-messages.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';
import { PlatformService } from '../platform/platform.service';

import type { Env } from '../../config/env.schema';

type InboundChannel = 'whatsapp' | 'email';

/**
 * Mensajes ENTRANTES del inquilino por WhatsApp o email (respuestas a los
 * envíos salientes del staff). El WABA/email de la plataforma es compartido por
 * todos los tenants, así que resolvemos el tenant+customer por el remitente
 * (teléfono o email) vía `PrismaAdminService` (bypass RLS: el webhook llega sin
 * contexto de tenant). El mensaje se registra en el mismo hilo de chat que el
 * portal (`customer_messages`), marcado con su canal de origen.
 */
@Injectable()
export class InboundMessagesService {
  private readonly logger = new Logger(InboundMessagesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly messages: CustomerMessagesService,
    private readonly platform: PlatformService,
    private readonly tickets: SupportTicketsService,
    private readonly files: FilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Últimos 9 dígitos (número nacional español) para casar formatos variados. */
  private phoneSuffix(phone: string): string | null {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : null;
  }

  /**
   * Resuelve un remitente ambiguo (mismo teléfono/email en varios tenants —
   * el canal WABA/email es compartido por toda la plataforma, así que esto
   * pasa de verdad) por la comunicación SALIENTE más reciente de ese canal a
   * alguno de los candidatos: una respuesta entrante casi siempre pertenece a
   * la conversación que un tenant inició de verdad. Si ningún candidato tiene
   * ese rastro, NO hay señal fiable para elegir uno — devolver `null` en vez
   * de adivinar (p.ej. el primero que devuelva la BD, orden no garantizado)
   * evita filtrar el mensaje de un inquilino al panel de un tenant ajeno.
   */
  private async disambiguate(
    channel: InboundChannel,
    candidates: { id: string; tenantId: string }[],
  ): Promise<{ tenantId: string; customerId: string } | null> {
    if (candidates.length === 0) return null;
    if (candidates.length === 1)
      return { tenantId: candidates[0]!.tenantId, customerId: candidates[0]!.id };
    const recent = await this.admin.communication.findFirst({
      where: { channel, customerId: { in: candidates.map((c) => c.id) } },
      orderBy: { createdAt: 'desc' },
      select: { customerId: true, tenantId: true },
    });
    if (recent?.customerId) return { tenantId: recent.tenantId, customerId: recent.customerId };
    this.logger.warn(
      `inbound ${channel}: remitente ambiguo entre ${candidates.length} tenants sin conversación previa — descartado`,
    );
    return null;
  }

  private async resolveByPhone(
    from: string,
  ): Promise<{ tenantId: string; customerId: string } | null> {
    const suffix = this.phoneSuffix(from);
    if (!suffix) return null;
    const candidates = await this.admin.customer.findMany({
      where: { phone: { contains: suffix }, deletedAt: null },
      select: { id: true, tenantId: true },
      take: 25,
    });
    return this.disambiguate('whatsapp', candidates);
  }

  private async resolveByEmail(
    from: string,
  ): Promise<{ tenantId: string; customerId: string } | null> {
    const email = from.trim().toLowerCase();
    const candidates = await this.admin.customer.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, tenantId: true },
      take: 25,
    });
    return this.disambiguate('email', candidates);
  }

  /** Guarda los adjuntos válidos de un correo en la carpeta de su conversación. */
  private async storeAttachments(
    prefix: string,
    list: EmailInboundInput['attachments'],
  ): Promise<MessageAttachmentInput[]> {
    const stored: MessageAttachmentInput[] = [];
    for (const att of (list ?? []).slice(0, MESSAGE_MAX_ATTACHMENTS)) {
      const mimeType = MESSAGE_ATTACHMENT_MIME_TYPES.find(
        (m) => m === att.contentType.split(';')[0]?.trim().toLowerCase(),
      );
      if (!mimeType) continue;
      const body = Buffer.from(att.contentBase64, 'base64');
      if (body.length === 0 || body.length > MESSAGE_ATTACHMENT_MAX_BYTES) continue;
      const key = `${prefix}${randomUUID()}.${mimeType.split('/')[1]}`;
      await this.files.putObject({ bucket: 'uploads', key, body, contentType: mimeType });
      stored.push({ key, mimeType, filename: att.filename });
    }
    return stored;
  }

  /**
   * Respuesta a un correo nuestro: su dirección dice a qué conversación o ticket
   * pertenece, sin adivinar por el remitente. Devuelve null si no lleva dirección
   * propia y hay que seguir por el remitente.
   */
  async recordReply(input: EmailInboundInput, senderVerified: boolean): Promise<boolean | null> {
    const domain = this.config.get('INBOUND_EMAIL_DOMAIN', { infer: true });
    const target = parseReplyAddress(input.to, domain);
    if (!target) return null;
    const body = stripQuotedReply(input.text).slice(0, 5000);
    if (target.kind === 't') {
      const ticket = await this.admin.supportTicket.findUnique({
        where: { replyToken: target.token },
        select: { tenantId: true },
      });
      if (!ticket) return false;
      const attachments = await this.storeAttachments(
        `${ticket.tenantId}/support/`,
        input.attachments,
      );
      if (!body && attachments.length === 0) return false;
      return this.tickets.addEmailReply({
        token: target.token,
        from: input.from,
        body,
        attachments,
      });
    }
    const conversation = await this.admin.customerConversation.findUnique({
      where: { replyToken: target.token },
      select: { tenantId: true, customerId: true, customer: { select: { email: true } } },
    });
    if (!conversation) return false;
    const { tenantId, customerId } = conversation;
    const attachments = await this.storeAttachments(
      `${tenantId}/chat/${customerId}/`,
      input.attachments,
    );
    if (!body && attachments.length === 0) return false;
    // La dirección de respuesta no se adivina, pero se puede reenviar: si escribe
    // otra persona, el equipo lo ve marcado.
    const sameSender = conversation.customer.email?.toLowerCase() === input.from.toLowerCase();
    await this.messages.sendFromCustomer(
      tenantId,
      customerId,
      body,
      'email',
      senderVerified && sameSender,
      attachments,
    );
    return true;
  }

  /**
   * Registra un mensaje entrante. Best-effort: el webhook debe responder 200
   * para que el proveedor no reintente en bucle. Si nadie sabe de quién es, el
   * super admin recibe el mensaje en su panel para no perderlo.
   */
  async record(args: {
    channel: InboundChannel;
    from: string;
    body: string;
    /** Solo email: ¿reportó el proveedor DMARC `pass`? (WhatsApp lo autentica Meta). */
    senderVerified?: boolean;
  }): Promise<boolean> {
    const body = (args.channel === 'email' ? stripQuotedReply(args.body) : args.body).trim();
    if (!body) return false;
    const resolved =
      args.channel === 'whatsapp'
        ? await this.resolveByPhone(args.from)
        : await this.resolveByEmail(args.from);
    if (!resolved) {
      this.logger.warn(`inbound ${args.channel}: remitente no resoluble`);
      if (await claimAlert(this.admin, 'inbound_unmatched', args.from.toLowerCase(), 60)) {
        await this.platform.notify({
          type: 'inbound.unmatched',
          title: `Mensaje por ${args.channel === 'email' ? 'correo' : 'WhatsApp'} sin destinatario`,
          body: `De ${args.from}: ${body.slice(0, 300)}`,
        });
      }
      return false;
    }
    await this.messages.sendFromCustomer(
      resolved.tenantId,
      resolved.customerId,
      body.slice(0, 5000),
      args.channel,
      args.senderVerified ?? true,
    );
    if (args.senderVerified === false) {
      this.logger.warn(
        `inbound ${args.channel}: remitente NO verificado (sin DMARC pass) para ${resolved.customerId}`,
      );
    }
    return true;
  }
}
