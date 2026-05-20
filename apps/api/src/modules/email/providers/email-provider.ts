/**
 * Contrato comun para enviar emails. La implementacion se selecciona via
 * env `EMAIL_PROVIDER` (smtp para Mailpit en dev/test; resend para
 * produccion). Vease ADR sobre EmailProvider abstracto.
 */
export abstract class EmailProvider {
  abstract get name(): string;
  abstract send(args: SendEmailArgs): Promise<SendEmailResult>;
  /** Cerrar conexiones al apagar (transporter SMTP, etc.). */
  abstract close?(): Promise<void>;
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Si se omite, se usa el `from` por defecto del proveedor. */
  from?: string;
  /** Para tracking en logs/audit (no se manda al proveedor). */
  tags?: Record<string, string>;
}

export interface SendEmailResult {
  providerMessageId: string | null;
}

export const EMAIL_PROVIDER = Symbol('EmailProvider');
