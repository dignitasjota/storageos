import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { render } from '@react-email/render';
import { createTransport, type Transporter } from 'nodemailer';

import type { Env } from '../../config/env.schema';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { ReactElement } from 'react';

export interface SendMailArgs {
  to: string;
  subject: string;
  template: ReactElement;
}

/**
 * Cliente SMTP centralizado. En dev apunta a Mailpit (`localhost:1026`).
 * En produccion sera el proveedor que toque (Resend SMTP, etc.).
 *
 * Las plantillas se escriben como componentes React y se renderizan a
 * HTML + texto plano via `@react-email/render`.
 */
@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private transporter!: Transporter;

  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit(): void {
    const options: SMTPTransport.Options = {
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure: false,
      ignoreTLS: true,
    };
    // Mailpit dev escucha solo en IPv4; sin family:4, Node resuelve
    // `localhost` a `::1` y nodemailer falla con ECONNREFUSED. `family`
    // existe en el socket subyacente pero los tipos de @types/nodemailer
    // no lo exponen; lo anadimos por cast.
    (options as SMTPTransport.Options & { family?: number }).family = 4;
    this.transporter = createTransport(options);
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
  }

  async send(args: SendMailArgs): Promise<void> {
    const html = await render(args.template, { pretty: false });
    const text = await render(args.template, { plainText: true });
    const from = `${this.config.get('SMTP_FROM_NAME', { infer: true })} <${this.config.get('SMTP_FROM', { infer: true })}>`;

    try {
      await this.transporter.sendMail({
        from,
        to: args.to,
        subject: args.subject,
        html,
        text,
      });
    } catch (err) {
      this.logger.error(
        `Fallo al enviar email a ${args.to}: ${args.subject}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }
}
