import type { Env } from '../../../config/env.schema';
import type { ConfigService } from '@nestjs/config';

/**
 * Contrato comun para enviar emails. La implementacion se selecciona via
 * env `EMAIL_PROVIDER` (smtp para Mailpit en dev/test; brevo o resend en
 * produccion). Vease ADR sobre EmailProvider abstracto.
 */
export abstract class EmailProvider {
  abstract get name(): string;
  abstract send(args: SendEmailArgs): Promise<SendEmailResult>;
  /** Cerrar conexiones al apagar (transporter SMTP, etc.). */
  abstract close?(): Promise<void>;
}

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Si se omite, se usa el remitente por defecto (`EMAIL_FROM_*`). */
  from?: EmailAddress;
  /** Dirección a la que van las respuestas del destinatario. */
  replyTo?: EmailAddress;
  /** Para tracking en logs/audit (no se manda al proveedor). */
  tags?: Record<string, string>;
  /**
   * Proveedor obligatorio para este envío (p. ej. el dominio del tenant solo
   * está autenticado en Brevo). Si no tiene clave, se sigue el orden normal.
   */
  forceProvider?: 'brevo' | 'resend';
  /** Cabeceras extra (p. ej. `List-Unsubscribe` en correos comerciales). */
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  providerMessageId: string | null;
  /** Proveedor que entregó el correo (lo rellena el enrutador). */
  provider?: string;
}

export const EMAIL_PROVIDER = Symbol('EmailProvider');

/**
 * Formatea una dirección para cabeceras RFC 5322 (`"Nombre" <email>`). El
 * nombre se sanea (sin comillas, `<>` ni saltos de línea) para que un nombre
 * de tenant no pueda inyectar cabeceras ni romper el formato.
 */
export function formatAddress(addr: EmailAddress): string {
  const name = sanitizeDisplayName(addr.name);
  return name ? `"${name}" <${addr.email}>` : addr.email;
}

export function sanitizeDisplayName(name: string | undefined): string {
  if (!name) return '';
  return name
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}

/** Remitente por defecto de la plataforma (`EMAIL_FROM_NAME` + `EMAIL_FROM_ADDRESS`). */
export function platformFrom(config: ConfigService<Env, true>): EmailAddress {
  return {
    name: config.get('EMAIL_FROM_NAME', { infer: true }),
    email: config.get('EMAIL_FROM_ADDRESS', { infer: true }),
  };
}
