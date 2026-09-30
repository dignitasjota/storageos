import { Inject, Injectable, Logger } from '@nestjs/common';
import { render } from '@react-email/render';

import {
  EMAIL_PROVIDER,
  type EmailProvider,
  type SendEmailResult,
} from './providers/email-provider';
import { TenantSenderService } from './tenant-sender.service';

import type { ReactElement } from 'react';

export interface SendMailTemplateArgs {
  to: string;
  /**
   * Tenant en cuyo nombre se escribe a un inquilino: el correo sale con su
   * remitente (nombre del tenant + respuestas a su email). Sin él, remitente
   * de la plataforma (emails de cuenta, avisos al tenant, etc.).
   */
  tenantId?: string;
  subject: string;
  template: ReactElement;
  tags?: Record<string, string>;
}

export interface SendMailRenderedArgs {
  to: string;
  /**
   * Tenant en cuyo nombre se escribe a un inquilino: el correo sale con su
   * remitente (nombre del tenant + respuestas a su email). Sin él, remitente
   * de la plataforma (emails de cuenta, avisos al tenant, etc.).
   */
  tenantId?: string;
  subject: string;
  html: string;
  text: string;
  tags?: Record<string, string>;
}

/**
 * Facade del envio de email. Mantiene la API previa (`send({ template })`)
 * para todas las plantillas React Email actuales, y expone `sendRendered`
 * para que el CommunicationsService renderice plantillas custom de tenant
 * via Handlebars y envie HTML/texto plano ya finalizado.
 *
 * La implementacion concreta (SMTP / Resend / Brevo) se inyecta via `EMAIL_PROVIDER`.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    private readonly senders: TenantSenderService,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async send(args: SendMailTemplateArgs): Promise<SendEmailResult> {
    const html = await render(args.template, { pretty: false });
    const text = await render(args.template, { plainText: true });
    return this.sendRendered({
      to: args.to,
      subject: args.subject,
      html,
      text,
      ...(args.tenantId ? { tenantId: args.tenantId } : {}),
      ...(args.tags ? { tags: args.tags } : {}),
    });
  }

  async sendRendered(args: SendMailRenderedArgs): Promise<SendEmailResult> {
    const sender = args.tenantId ? await this.senders.resolve(args.tenantId) : null;
    try {
      return await this.provider.send({
        ...(sender ? { from: sender.from } : {}),
        ...(sender?.replyTo ? { replyTo: sender.replyTo } : {}),
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
        ...(args.tags ? { tags: args.tags } : {}),
      });
    } catch (err) {
      this.logger.error(
        `[email:${this.provider.name}] fallo enviando a ${args.to} (${args.subject})`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}

// Alias retro-compatible con los modulos que importaban `SendMailArgs`.
export type SendMailArgs = SendMailTemplateArgs;
