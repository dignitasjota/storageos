import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import { EmailProvider, type SendEmailArgs, type SendEmailResult } from './email-provider';

import type { Env } from '../../../config/env.schema';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/**
 * SMTP via nodemailer. En dev apunta a Mailpit (localhost:1026). Tambien
 * usable como fallback de Resend si se configura un relay propio.
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
    const options: SMTPTransport.Options = {
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure: false,
      ignoreTLS: true,
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
    const fromName = this.config.get('EMAIL_FROM_NAME', { infer: true });
    const fromAddress = this.config.get('EMAIL_FROM_ADDRESS', { infer: true });
    const from = args.from ?? `${fromName} <${fromAddress}>`;
    try {
      const result = await this.transporter.sendMail({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
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
