/**
 * Provider abstracto de WhatsApp Business. En Fase 5 solo existe el stub
 * (no envia, solo loggea), preparando el camino para Meta WABA en Fase 8.
 *
 * Mismo patron que `EmailProvider` y `PaymentGateway`: clase abstracta +
 * `Symbol` DI + factory en el modulo.
 */
export abstract class WhatsAppProvider {
  abstract get name(): string;
  /**
   * ¿Puede enviar de verdad? El simulador solo «envía» en desarrollo y tests;
   * Meta necesita su número y token.
   */
  abstract get available(): boolean;
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
  /** No se envió (WhatsApp sin configurar). Motivo para el historial. */
  skipped?: string;
}

/** Motivo de un envío por WhatsApp que no puede salir. */
export const WHATSAPP_NOT_CONFIGURED = 'No enviado: WhatsApp no está configurado en la plataforma';

export const WHATSAPP_PROVIDER = Symbol('WhatsAppProvider');
