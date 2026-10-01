import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  EmailProvider,
  platformFrom,
  sanitizeDisplayName,
  type EmailAddress,
  type SendEmailArgs,
  type SendEmailResult,
} from './email-provider';

import type { Env } from '../../../config/env.schema';

export const BREVO_API_BASE = 'https://api.brevo.com/v3';

interface BrevoSuccess {
  messageId?: string;
}
interface BrevoError {
  code?: string;
  message?: string;
}

/**
 * Provider HTTP que envía por la API transaccional de Brevo
 * (`POST /v3/smtp/email`). Sin SDK, como Resend: la API es REST simple.
 *
 * Requiere `BREVO_API_KEY` (Brevo → SMTP & API → API keys). El remitente debe
 * pertenecer a un dominio autenticado en esa cuenta de Brevo (la plataforma, y
 * más adelante los dominios propios de cada tenant).
 */
@Injectable()
export class BrevoEmailProvider extends EmailProvider {
  private readonly logger = new Logger(BrevoEmailProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  get name(): string {
    return 'brevo';
  }

  async close(): Promise<void> {
    // Sin estado persistente.
  }

  async send(args: SendEmailArgs): Promise<SendEmailResult> {
    const apiKey = this.config.get('BREVO_API_KEY', { infer: true });
    if (!apiKey) {
      throw new Error('BREVO_API_KEY no configurada; EMAIL_PROVIDER=brevo');
    }
    const body = buildBrevoPayload(args, platformFrom(this.config));
    const response = await fetch(`${BREVO_API_BASE}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = (await response.json().catch(() => null)) as BrevoError | null;
      const msg = err?.message ?? response.statusText;
      this.logger.error(`Brevo ${response.status}: ${msg} (to=${args.to})`);
      throw new Error(`Brevo send failed: ${msg}`);
    }
    const ok = (await response.json().catch(() => ({}))) as BrevoSuccess;
    return { providerMessageId: ok.messageId ?? null };
  }
}

/** Cuerpo de `POST /v3/smtp/email`. Exportado para tests. */
export function buildBrevoPayload(
  args: SendEmailArgs,
  defaultFrom: EmailAddress,
): Record<string, unknown> {
  const from = args.from ?? defaultFrom;
  return {
    sender: toBrevoContact(from),
    to: [{ email: args.to }],
    subject: args.subject,
    htmlContent: args.html,
    textContent: args.text,
    ...(args.replyTo ? { replyTo: toBrevoContact(args.replyTo) } : {}),
    ...(args.headers && Object.keys(args.headers).length > 0 ? { headers: args.headers } : {}),
    // Brevo admite tags como lista de strings: se envían `clave:valor`.
    ...(args.tags && Object.keys(args.tags).length > 0
      ? { tags: Object.entries(args.tags).map(([k, v]) => `${k}:${v}`) }
      : {}),
  };
}

function toBrevoContact(addr: EmailAddress): { email: string; name?: string } {
  const name = sanitizeDisplayName(addr.name);
  return name ? { email: addr.email, name } : { email: addr.email };
}
