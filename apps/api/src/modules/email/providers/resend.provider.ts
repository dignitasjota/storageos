import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailProvider, type SendEmailArgs, type SendEmailResult } from './email-provider';

import type { Env } from '../../../config/env.schema';

interface ResendSuccess {
  id: string;
}
interface ResendError {
  name: string;
  message: string;
}

/**
 * Provider HTTP que envia via la API de Resend (resend.com). No usamos
 * el SDK oficial para evitar una dependencia mas; la API es REST simple
 * y nodemailer ya cubre el camino SMTP si se configura un relay propio.
 *
 * Requiere `RESEND_API_KEY`. Sin clave, el provider lanza al enviar
 * (el config valida que si EMAIL_PROVIDER=resend, la clave este puesta:
 * lo hacemos defensivo aqui porque z.string().default('') admite ambos).
 */
@Injectable()
export class ResendEmailProvider extends EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  get name(): string {
    return 'resend';
  }

  async close(): Promise<void> {
    // Sin estado persistente.
  }

  async send(args: SendEmailArgs): Promise<SendEmailResult> {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    if (!apiKey) {
      throw new Error('RESEND_API_KEY no configurada; EMAIL_PROVIDER=resend');
    }
    const fromName = this.config.get('EMAIL_FROM_NAME', { infer: true });
    const fromAddress = this.config.get('EMAIL_FROM_ADDRESS', { infer: true });
    const from = args.from ?? `${fromName} <${fromAddress}>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text,
        tags: args.tags
          ? Object.entries(args.tags).map(([name, value]) => ({ name, value }))
          : undefined,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ResendError | null;
      const msg = body?.message ?? response.statusText;
      this.logger.error(`Resend ${response.status}: ${msg} (to=${args.to})`);
      throw new Error(`Resend send failed: ${msg}`);
    }
    const body = (await response.json()) as ResendSuccess;
    return { providerMessageId: body.id ?? null };
  }
}
