/**
 * Provider abstracto de WhatsApp Business. En Fase 5 solo existe el stub
 * (no envia, solo loggea), preparando el camino para Meta WABA en Fase 8.
 *
 * Mismo patron que `EmailProvider` y `PaymentGateway`: clase abstracta +
 * `Symbol` DI + factory en el modulo.
 */
export abstract class WhatsAppProvider {
  abstract get name(): string;
  abstract send(args: SendWhatsAppArgs): Promise<SendWhatsAppResult>;
}

export interface SendWhatsAppArgs {
  to: string;
  body: string;
  /** Identificador de plantilla aprobada en WABA (futuro). */
  templateName?: string;
  templateLanguage?: string;
  templateVariables?: Record<string, string>;
}

export interface SendWhatsAppResult {
  providerMessageId: string | null;
}

export const WHATSAPP_PROVIDER = Symbol('WhatsAppProvider');
