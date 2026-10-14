import { z } from 'zod';

/**
 * Extra «WhatsApp Business»: el número de WhatsApp del tenant (Cloud API de
 * Meta) en su web, con bandeja de conversaciones en el panel.
 */

/** Ventana en la que se puede escribir libremente tras el último mensaje del contacto. */
export const WHATSAPP_SERVICE_WINDOW_HOURS = 24;

export const UpdateWhatsappSettingsSchema = z
  .object({
    /** ID del número en Meta (Phone number ID). */
    phoneNumberId: z
      .string()
      .trim()
      .regex(/^\d{5,30}$/, 'El ID del número solo lleva cifras')
      .optional(),
    /** ID de la cuenta de WhatsApp Business (WABA). */
    wabaId: z
      .string()
      .trim()
      .regex(/^\d{5,30}$/, 'El ID de la cuenta solo lleva cifras')
      .optional()
      .or(z.literal('')),
    /** Token de acceso permanente. Vacío/ausente = conservar el actual. */
    accessToken: z.string().trim().min(20).max(1000).optional(),
    enabled: z.boolean().optional(),
    /** Botón flotante de WhatsApp en la web pública. */
    webButtonEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWhatsappSettingsInput = z.infer<typeof UpdateWhatsappSettingsSchema>;

export interface WhatsappSettingsDto {
  configured: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  /** Número tal como lo muestra Meta (p. ej. «+34 600 00 00 00»). */
  displayPhone: string | null;
  verifiedName: string | null;
  /** Últimos 4 caracteres del token (nunca se devuelve entero). */
  tokenLast4: string | null;
  enabled: boolean;
  webButtonEnabled: boolean;
  lastCheckedAt: string | null;
}

export interface WhatsappTestResultDto {
  ok: boolean;
  displayPhone: string | null;
  verifiedName: string | null;
  error: string | null;
}

export type WhatsappMessageSender = 'contact' | 'staff' | 'assistant';
export type WhatsappMessageStatus = 'received' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsappConversationDto {
  id: string;
  waId: string;
  contactName: string | null;
  customerId: string | null;
  customerName: string | null;
  leadId: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  unreadCount: number;
  /** Última vez que escribió el contacto (abre la ventana de 24 h). */
  lastInboundAt: string | null;
  /** Se puede escribir libremente (dentro de la ventana de 24 h). */
  canReply: boolean;
  assistantEnabled: boolean;
}

export interface WhatsappMessageDto {
  id: string;
  direction: 'in' | 'out';
  sender: WhatsappMessageSender;
  body: string;
  status: WhatsappMessageStatus;
  error: string | null;
  sentByName: string | null;
  createdAt: string;
}

export interface WhatsappConversationDetailDto extends WhatsappConversationDto {
  messages: WhatsappMessageDto[];
}

export const SendWhatsappMessageSchema = z.object({
  body: z.string().trim().min(1).max(4096),
});
export type SendWhatsappMessageInput = z.infer<typeof SendWhatsappMessageSchema>;

/** Número de WhatsApp listo para un enlace `wa.me` (solo cifras, con prefijo). */
export function waMeNumber(displayPhone: string | null | undefined): string | null {
  const digits = (displayPhone ?? '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  // Sin prefijo de país (9 cifras españolas) → +34.
  return digits.length === 9 ? `34${digits}` : digits;
}
