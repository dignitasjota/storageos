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

// ─── Asistente de IA del WhatsApp (PR 2) ────────────────────────────────────

/**
 * Proveedores de IA para el asistente de WhatsApp (independiente de la IA del
 * panel). MiniMax y «compatible con OpenAI» usan el formato de OpenAI.
 */
export const WHATSAPP_AI_PROVIDERS = [
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-haiku-4-5-20251001',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'minimax',
    label: 'MiniMax',
    defaultModel: 'MiniMax-M2',
    baseUrl: 'https://api.minimax.io/v1',
  },
  {
    value: 'openai_compatible',
    label: 'Compatible con OpenAI (otra URL)',
    defaultModel: '',
    baseUrl: null,
  },
] as const;
export type WhatsappAiProvider = (typeof WHATSAPP_AI_PROVIDERS)[number]['value'];
const providerValues = WHATSAPP_AI_PROVIDERS.map((p) => p.value) as [
  WhatsappAiProvider,
  ...WhatsappAiProvider[],
];
export const WhatsappAiProviderEnum = z.enum(providerValues);

export function isWhatsappAiProvider(v: string | null | undefined): v is WhatsappAiProvider {
  return !!v && (providerValues as readonly string[]).includes(v);
}

/** URL base de la API de un proveedor (la propia si es «compatible con OpenAI»). */
export function whatsappAiBaseUrl(
  provider: WhatsappAiProvider,
  customBaseUrl: string | null | undefined,
): string | null {
  const preset = WHATSAPP_AI_PROVIDERS.find((p) => p.value === provider);
  return (preset?.baseUrl ?? customBaseUrl ?? '').replace(/\/+$/, '') || null;
}

const aiBaseUrl = z
  .string()
  .trim()
  .max(500)
  .url('URL no válida')
  .refine((u) => u.startsWith('https://'), 'La URL tiene que empezar por https://')
  .optional()
  .or(z.literal(''));

export const WhatsappAiModeEnum = z.enum(['platform', 'own']);
export type WhatsappAiMode = z.infer<typeof WhatsappAiModeEnum>;

/** IA de WhatsApp de la plataforma (panel admin). */
export const UpdatePlatformWhatsappAiSchema = z.object({
  enabled: z.boolean().optional(),
  provider: WhatsappAiProviderEnum.optional(),
  model: z.string().trim().max(120).optional(),
  baseUrl: aiBaseUrl,
  /** Vacío/ausente = conservar la actual. */
  apiKey: z.string().trim().min(10).max(500).optional(),
  monthlyReplyLimit: z.number().int().min(0).max(100_000).optional(),
});
export type UpdatePlatformWhatsappAiInput = z.infer<typeof UpdatePlatformWhatsappAiSchema>;

export interface PlatformWhatsappAiDto {
  enabled: boolean;
  provider: WhatsappAiProvider;
  model: string;
  baseUrl: string | null;
  keyLast4: string | null;
  monthlyReplyLimit: number;
  updatedAt: string;
}

export interface WhatsappAiTestResultDto {
  ok: boolean;
  /** Respuesta de prueba del modelo (recortada). */
  sample: string | null;
  error: string | null;
}

/** Ajustes de IA de WhatsApp de un tenant que cambia el super admin. */
export const UpdateAdminTenantWhatsappAiSchema = z.object({
  aiMode: WhatsappAiModeEnum.optional(),
  /** null = usar el límite general. */
  aiMonthlyLimit: z.number().int().min(0).max(100_000).nullable().optional(),
});
export type UpdateAdminTenantWhatsappAiInput = z.infer<typeof UpdateAdminTenantWhatsappAiSchema>;

export interface WhatsappAiUsageDto {
  /** Respuestas este mes con la IA de la plataforma. */
  platformRepliesThisMonth: number;
  /** Respuestas este mes con la clave propia del tenant. */
  ownRepliesThisMonth: number;
  /** Límite efectivo (el del tenant o el general). */
  limit: number;
}

export interface AdminTenantWhatsappAiDto {
  configured: boolean;
  displayPhone: string | null;
  assistantEnabled: boolean;
  aiMode: WhatsappAiMode;
  aiMonthlyLimit: number | null;
  ownKeyConfigured: boolean;
  ownProvider: WhatsappAiProvider | null;
  usage: WhatsappAiUsageDto;
}

/** Asistente y clave propia (panel del tenant). */
export const UpdateWhatsappAssistantSchema = z
  .object({
    assistantEnabled: z.boolean().optional(),
    assistantInstructions: z.string().trim().max(2000).optional().or(z.literal('')),
    ownProvider: WhatsappAiProviderEnum.optional(),
    ownModel: z.string().trim().max(120).optional(),
    ownBaseUrl: aiBaseUrl,
    ownApiKey: z.string().trim().min(10).max(500).optional(),
    /** Quita la clave propia. */
    removeOwnKey: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWhatsappAssistantInput = z.infer<typeof UpdateWhatsappAssistantSchema>;

export interface WhatsappAssistantDto {
  assistantEnabled: boolean;
  assistantInstructions: string | null;
  aiMode: WhatsappAiMode;
  /** La IA de TrasterOS está disponible (configurada y activa). */
  platformAiAvailable: boolean;
  ownAi: {
    provider: WhatsappAiProvider;
    model: string;
    baseUrl: string | null;
    keyLast4: string | null;
  } | null;
  usage: WhatsappAiUsageDto;
}

export const UpdateWhatsappConversationSchema = z.object({
  assistantEnabled: z.boolean(),
});
export type UpdateWhatsappConversationInput = z.infer<typeof UpdateWhatsappConversationSchema>;
