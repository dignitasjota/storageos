import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { renderAdminEmail, replyAddressOf } from '@storageos/shared';

import { PrismaAdminService } from '../../../database/prisma-admin.service';
import { EmailService } from '../../../email/email.service';
import { FilesService } from '../../../files/files.service';

import type { StoredAttachment } from '../../../../common/message-attachments';
import type { Env } from '../../../../config/env.schema';

/** Remitente de un correo a un lead: el comercial que lo lleva (y su firma). */
export interface LeadEmailSender {
  fromName: string;
  replyTo: { email: string; name?: string };
  /** Firma con la que acaba la propuesta (en vez de «El equipo de TrasterOS»). */
  signature?: string;
}

/** Los enlaces de los adjuntos valen lo que permite una URL firmada: 7 días. */
const ATTACHMENT_LINK_SECONDS = 7 * 86_400;

/**
 * Correos a los leads del panel admin. Con dominio de correo entrante, salen
 * con una dirección de respuesta propia del lead (`p-<token>@<dominio>`): lo
 * que conteste vuelve a su ficha. Sin él, como siempre (el comercial o el
 * email del formulario de la web). Lo usan la ficha, la propuesta y las
 * secuencias (también desde el worker).
 */
@Injectable()
export class PlatformLeadMailService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly files: FilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** ¿Las respuestas vuelven a la ficha? (hay dominio de correo entrante). */
  get repliesToThread(): boolean {
    return !!this.config.get('INBOUND_EMAIL_DOMAIN', { infer: true });
  }

  /** Dirección de respuesta propia del lead, o null sin dominio de correo entrante. */
  async replyAddress(leadId: string): Promise<string | null> {
    const domain = this.config.get('INBOUND_EMAIL_DOMAIN', { infer: true });
    if (!domain) return null;
    const lead = await this.admin.platformLead.findUnique({
      where: { id: leadId },
      select: { replyToken: true },
    });
    if (!lead) return null;
    let token = lead.replyToken;
    if (!token) {
      token = randomBytes(16).toString('hex');
      const { count } = await this.admin.platformLead.updateMany({
        where: { id: leadId, replyToken: null },
        data: { replyToken: token },
      });
      if (count === 0) {
        token =
          (
            await this.admin.platformLead.findUnique({
              where: { id: leadId },
              select: { replyToken: true },
            })
          )?.replyToken ?? token;
      }
    }
    return replyAddressOf('p', token, domain);
  }

  /**
   * Envía el correo. Los adjuntos van como enlaces de descarga (7 días): el
   * proveedor de correo no admite ficheros. Lanza 400 `email_suppressed` si la
   * dirección está bloqueada por rebotes o quejas.
   */
  async send(args: {
    leadId: string;
    to: string;
    name: string | null;
    subject: string;
    markdown: string;
    sender?: LeadEmailSender | undefined;
    attachments?: StoredAttachment[];
  }): Promise<void> {
    const reply = await this.replyAddress(args.leadId);
    const website =
      reply || args.sender
        ? null
        : await this.admin.platformWebsite.findFirst({ select: { contactEmail: true } });
    let markdown = args.markdown;
    if (args.attachments?.length) {
      const links = await Promise.all(
        args.attachments.map(async (a) => {
          const url = await this.files.getPresignedGetUrl(
            'uploads',
            a.key,
            ATTACHMENT_LINK_SECONDS,
            a.filename,
          );
          return `- [${a.filename.replace(/[[\]]/g, '')}](${url})`;
        }),
      );
      markdown = `${markdown}\n\n**Adjuntos** (los enlaces valen 7 días):\n${links.join('\n')}`;
    }
    const mail = renderAdminEmail(markdown);
    const replyTo = reply
      ? { email: reply, ...(args.sender ? { name: args.sender.fromName } : {}) }
      : args.sender
        ? args.sender.replyTo
        : website?.contactEmail
          ? { email: website.contactEmail }
          : null;
    const result = await this.email.sendRendered({
      to: args.to,
      subject: args.subject,
      html: mail.html,
      text: mail.text,
      ...(replyTo ? { replyTo } : {}),
      ...(args.sender ? { fromName: args.sender.fromName } : {}),
      kind: 'web_contact',
      tags: { type: args.sender ? 'sales' : 'platform_lead' },
    });
    if (result.suppressed) {
      throw new BadRequestException({
        code: 'email_suppressed',
        message: `${args.name ?? args.to} tiene la dirección bloqueada (rebotes o quejas): no se le puede escribir`,
      });
    }
  }
}
