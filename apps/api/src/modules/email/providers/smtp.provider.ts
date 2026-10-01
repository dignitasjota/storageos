import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import {
  EmailProvider,
  formatAddress,
  platformFrom,
  type SendEmailArgs,
  type SendEmailResult,
} from './email-provider';

import type { Env } from '../../../config/env.schema';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/**
 * SMTP via nodemailer. En dev apunta a Mailpit (localhost:1026). Tambien
 * sirve para un relay con autenticación (p. ej. `smtp-relay.brevo.com:587`
 * con `SMTP_USER`/`SMTP_PASSWORD`): con usuario se exige STARTTLS; sin él
 * (Mailpit) no se usa TLS.
 *
 * Workaround `family: 4`: Mailpit en dev escucha solo en IPv4 y Node
 * resuelve `localhost` a `::1` por defecto, provocando ECONNREFUSED.
 */
@Injectable()
export class SmtpEmailProvider extends EmailProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private transporter!: Transporter;

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  get name(): string {
    return 'smtp';
  }

  onModuleInit(): void {
    const user = this.config.get('SMTP_USER', { infer: true });
    const pass = this.config.get('SMTP_PASSWORD', { infer: true });
    const secure = this.config.get('SMTP_SECURE', { infer: true });
    const options: SMTPTransport.Options = {
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure,
      ...(user ? { auth: { user, pass }, requireTLS: !secure } : { ignoreTLS: true }),
    };
    (options as SMTPTransport.Options & { family?: number }).family = 4;
    this.transporter = createTransport(options);
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
  }

  async close(): Promise<void> {
    this.transporter?.close();
  }

  async send(args: SendEmailArgs): Promise<SendEmailResult> {
    const from = formatAddress(args.from ?? platformFrom(this.config));
    try {
      const result = await this.transporter.sendMail({
        from,
        ...(args.replyTo ? { replyTo: formatAddress(args.replyTo) } : {}),
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
        ...(args.headers ? { headers: args.headers } : {}),
      });
      return { providerMessageId: result.messageId ?? null };
    } catch (err) {
      this.logger.error(
        `Fallo SMTP al enviar a ${args.to}: ${args.subject}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
