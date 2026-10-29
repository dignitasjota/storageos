import { z } from 'zod';

import { OpeningHoursSchema, type OpeningHours } from '../facilities/schemas';

// ─── Intenciones, horario del asistente y seguimiento ───────────────────────

/** Lo que busca el contacto (lo detecta el asistente en cada mensaje). */
export const WHATSAPP_INTENTS = [
  'precio',
  'disponibilidad',
  'reserva',
  'horario',
  'pago',
  'reclamacion',
  'baja',
  'otro',
] as const;
export type WhatsappIntent = (typeof WHATSAPP_INTENTS)[number];

export const WHATSAPP_INTENT_LABELS: Record<WhatsappIntent, string> = {
  precio: 'Precio',
  disponibilidad: 'Disponibilidad',
  reserva: 'Reserva',
  horario: 'Horario',
  pago: 'Pagos',
  reclamacion: 'Reclamación',
  baja: 'Baja',
  otro: 'Otro',
};

export function isWhatsappIntent(v: unknown): v is WhatsappIntent {
  return typeof v === 'string' && (WHATSAPP_INTENTS as readonly string[]).includes(v);
}

/** Intenciones de quien está pensando en alquilar (las que reciben el seguimiento). */
export const WHATSAPP_SALES_INTENTS: readonly WhatsappIntent[] = [
  'precio',
  'disponibilidad',
  'reserva',
];

/**
 * Cuándo responde la IA: `always`; `outside` = solo fuera del horario del
 * equipo (dentro responde el equipo); `inside` = solo dentro.
 */
export const WHATSAPP_ASSISTANT_HOURS_MODES = ['always', 'outside', 'inside'] as const;
export type WhatsappAssistantHoursMode = (typeof WHATSAPP_ASSISTANT_HOURS_MODES)[number];

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** ¿Está `at` dentro del horario `hours` en la zona `timeZone`? Sin horario = no. */
export function isWithinHours(
  hours: OpeningHours | null | undefined,
  timeZone: string,
  at: Date = new Date(),
): boolean {
  if (!hours) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const wd = parts
    .find((p) => p.type === 'weekday')
    ?.value.toLowerCase()
    .slice(0, 3);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const key = WEEKDAY_KEYS.find((k) => k === wd);
  if (!key) return false;
  const day = hours[key];
  if (!day) return false;
  const now = `${hh}:${mm}`;
  return now >= day.open && (day.close === '00:00' || now < day.close);
}

/** ¿Responde la IA ahora según el modo y el horario del equipo? */
export function assistantRespondsNow(
  mode: string,
  teamHours: OpeningHours | null | undefined,
  timeZone: string,
  at: Date = new Date(),
): boolean {
  if (mode === 'outside') return !isWithinHours(teamHours, timeZone, at);
  if (mode === 'inside') return isWithinHours(teamHours, timeZone, at);
  return true;
}

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
    /**
     * Secreto de la app de Meta del tenant (si el número está en su propia app):
     * con él se comprueba la firma de sus avisos. '' = quitarlo.
     */
    appSecret: z.string().trim().min(16).max(200).optional().or(z.literal('')),
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
  /** URL del webhook para configurarla en la app de Meta. */
  webhookUrl: string;
  /** Token de verificación del webhook (si usa su propia app de Meta). */
  webhookVerifyToken: string | null;
  /** Ha guardado el secreto de su app de Meta. */
  appSecretConfigured: boolean;
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
  /** Reserva preparada por el asistente en esta conversación. */
  contractId: string | null;
  /** Intención del último mensaje del contacto (la detecta el asistente). */
  intent: WhatsappIntent | null;
  /** Resumen para el equipo cuando el asistente pasó la conversación a una persona. */
  handoffSummary: string | null;
}

export const WHATSAPP_MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
export type WhatsappMediaType = (typeof WHATSAPP_MEDIA_TYPES)[number];

export const WHATSAPP_MEDIA_LABELS: Record<WhatsappMediaType, string> = {
  image: 'Foto',
  audio: 'Audio',
  video: 'Vídeo',
  document: 'Documento',
  sticker: 'Sticker',
};

export interface WhatsappMessageMediaDto {
  type: WhatsappMediaType;
  mime: string | null;
  filename: string | null;
  size: number | null;
  /** URL firmada temporal; null si el archivo no se pudo guardar. */
  url: string | null;
}

/** Archivos que el equipo puede enviar desde la bandeja. */
export const WHATSAPP_OUTGOING_MEDIA_MIMES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type WhatsappOutgoingMediaMime = (typeof WHATSAPP_OUTGOING_MEDIA_MIMES)[number];
/** Límites de Meta: fotos 5 MB; documentos hasta 100 MB (aquí, 20 MB). */
export const WHATSAPP_OUTGOING_MAX_BYTES: Record<WhatsappOutgoingMediaMime, number> = {
  'image/jpeg': 5 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'application/pdf': 20 * 1024 * 1024,
};

export const RequestWhatsappMediaUploadSchema = z.object({
  mimeType: z.enum(WHATSAPP_OUTGOING_MEDIA_MIMES),
  filename: z.string().trim().min(1).max(200),
  size: z.number().int().positive(),
});
export type RequestWhatsappMediaUploadInput = z.infer<typeof RequestWhatsappMediaUploadSchema>;

export interface WhatsappMediaUploadDto {
  key: string;
  uploadUrl: string;
}

export const SendWhatsappMediaSchema = z.object({
  key: z.string().min(1).max(500),
  mimeType: z.enum(WHATSAPP_OUTGOING_MEDIA_MIMES),
  filename: z.string().trim().min(1).max(200),
  caption: z.string().trim().max(1024).optional(),
});
export type SendWhatsappMediaInput = z.infer<typeof SendWhatsappMediaSchema>;

export interface WhatsappMessageDto {
  id: string;
  direction: 'in' | 'out';
  sender: WhatsappMessageSender;
  body: string;
  status: WhatsappMessageStatus;
  error: string | null;
  sentByName: string | null;
  createdAt: string;
  media: WhatsappMessageMediaDto | null;
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
/** Nombre de plantilla de WhatsApp tal como está en Meta (minúsculas, cifras y _). */
export const WhatsappTemplateNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,512}$/, 'Solo minúsculas, cifras y guiones bajos');
/** Código de idioma de la plantilla (es, en, es_ES, en_US…). */
export const WhatsappTemplateLanguageSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Código de idioma no válido (p. ej. es o es_ES)');

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
    /** El asistente puede preparar reservas desde el chat. */
    assistantBookingsEnabled: z.boolean().optional(),
    /** Plantilla aprobada en Meta para el recordatorio ({{1}} nombre, {{2}} enlace). '' = ninguna. */
    reminderTemplateName: WhatsappTemplateNameSchema.optional().or(z.literal('')),
    reminderTemplateLanguage: WhatsappTemplateLanguageSchema.optional(),
    /** Política de privacidad (https) que enlaza el aviso del primer mensaje. '' = ninguna. */
    privacyUrl: z
      .string()
      .trim()
      .max(500)
      .url('URL no válida')
      .refine((v) => v.startsWith('https://'), 'La URL debe empezar por https://')
      .optional()
      .or(z.literal('')),
    /** Cuándo responde la IA: siempre, solo fuera del horario del equipo o solo dentro. */
    assistantHoursMode: z.enum(WHATSAPP_ASSISTANT_HOURS_MODES).optional(),
    /** Horario del equipo, en la zona del negocio. */
    teamHours: OpeningHoursSchema.optional(),
    /** Intenciones que avisan al equipo. */
    alertIntents: z.array(z.enum(WHATSAPP_INTENTS)).max(WHATSAPP_INTENTS.length).optional(),
    /** Recordatorio al contacto que preguntó y no siguió. */
    followupEnabled: z.boolean().optional(),
    /** Plantilla para el recordatorio pasadas las 24 h ({{1}} nombre). '' = ninguna. */
    followupTemplateName: WhatsappTemplateNameSchema.optional().or(z.literal('')),
    followupTemplateLanguage: WhatsappTemplateLanguageSchema.optional(),
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
  assistantBookingsEnabled: boolean;
  reminderTemplateName: string | null;
  reminderTemplateLanguage: string;
  privacyUrl: string | null;
  assistantHoursMode: WhatsappAssistantHoursMode;
  teamHours: OpeningHours;
  alertIntents: WhatsappIntent[];
  followupEnabled: boolean;
  followupTemplateName: string | null;
  followupTemplateLanguage: string;
}

export const UpdateWhatsappConversationSchema = z.object({
  assistantEnabled: z.boolean(),
});
export type UpdateWhatsappConversationInput = z.infer<typeof UpdateWhatsappConversationSchema>;

/** Mensaje con plantilla aprobada (para escribir pasadas las 24 h). */
export const SendWhatsappTemplateSchema = z.object({
  name: WhatsappTemplateNameSchema,
  language: WhatsappTemplateLanguageSchema.default('es'),
  /** Valores de las variables del cuerpo, en orden ({{1}}, {{2}}…). */
  params: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
});
export type SendWhatsappTemplateInput = z.infer<typeof SendWhatsappTemplateSchema>;

/**
 * Aviso que el asistente añade a su primera respuesta en cada conversación:
 * quien escribe sabe que le responde una IA y que puede pedir una persona.
 */
export function whatsappAssistantNotice(
  privacyUrl: string | null,
  language: WhatsappTextLanguage = 'es',
): string {
  const en = language === 'en';
  return [
    en
      ? 'ℹ️ You are chatting with an AI assistant. If you would rather talk to a person, just say so.'
      : 'ℹ️ Te responde un asistente automático con inteligencia artificial. Si prefieres hablar con una persona, escríbelo.',
    privacyUrl
      ? `${en ? 'How we handle your data' : 'Cómo tratamos tus datos'}: ${privacyUrl}`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Idiomas de los textos fijos del WhatsApp (el resto de idiomas va en inglés). */
export type WhatsappTextLanguage = 'es' | 'en';

/** Idioma de los textos fijos según el idioma detectado del contacto. */
export function whatsappTextLanguage(language: string | null | undefined): WhatsappTextLanguage {
  if (!language) return 'es';
  const code = language.toLowerCase().slice(0, 2);
  // Idiomas de España: los textos en español.
  return ['es', 'ca', 'gl', 'eu'].includes(code) ? 'es' : 'en';
}

/** Plantilla aprobada en Meta (para elegirla en la bandeja y en el recordatorio). */
export interface WhatsappTemplateDto {
  name: string;
  language: string;
  category: string | null;
  /** Texto del cuerpo con las variables {{1}}, {{2}}… */
  body: string;
  /** Nº de variables del cuerpo. */
  paramCount: number;
}

export interface WhatsappTemplatesDto {
  /** Falta el ID de la cuenta de WhatsApp Business en los ajustes. */
  wabaConfigured: boolean;
  templates: WhatsappTemplateDto[];
  error: string | null;
}

/** Nº de variables {{n}} distintas de un texto de plantilla. */
export function templateParamCount(body: string): number {
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length === 0 ? 0 : Math.max(...nums);
}

/** Resumen del WhatsApp del tenant en un periodo. */
export interface WhatsappStatsDto {
  days: number;
  conversations: number;
  inboundMessages: number;
  assistantReplies: number;
  staffReplies: number;
  /** Conversaciones que el asistente pasó a una persona. */
  handoffs: number;
  /** Reservas preparadas por el asistente / ya firmadas. */
  bookings: number;
  bookingsSigned: number;
  /** Mediana de minutos hasta la primera respuesta (asistente o equipo). */
  medianFirstResponseMinutes: number | null;
}
