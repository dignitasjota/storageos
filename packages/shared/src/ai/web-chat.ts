import { z } from 'zod';

import { AdClickIdsSchema, utmFields } from '../communications/schemas';
import { OpeningHoursSchema, type OpeningHours } from '../facilities/schemas';

/**
 * Chat con IA en la web pública del tenant: lo usa un visitante anónimo, solo
 * con la información pública del negocio (locales, horarios, tamaños,
 * precios, promoción y preguntas frecuentes).
 */

/** Máximo de caracteres de un mensaje del visitante. */
export const WEB_CHAT_MESSAGE_MAX = 500;

/** Minutos que se espera a una persona antes de pedir los datos de contacto. */
export const WEB_CHAT_HANDOFF_WAIT_MINUTES = 5;

/** Segundos en la página de reserva antes de ofrecer ayuda (una vez por sesión). */
export const WEB_CHAT_PROACTIVE_SECONDS = 45;

/** Id aleatorio del navegador (el mismo que la analítica de la web). */
export const WebChatVisitorIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PublicWebChatSchema = z.object({
  visitorId: WebChatVisitorIdSchema,
  message: z.string().trim().min(1).max(WEB_CHAT_MESSAGE_MAX),
  locale: z.enum(['es', 'en']).default('es'),
  /** Página desde la que escribe (como la ve el visitante). */
  pagePath: z.string().trim().max(300).optional(),
  /** Origen de su visita (el que guarda la web): sus reservas y contactos lo heredan. */
  ...utmFields,
  /** Campo trampa: un robot lo rellena. */
  hp: z.string().max(200).optional(),
});
export type PublicWebChatInput = z.infer<typeof PublicWebChatSchema>;

export interface WebChatContactDto {
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
}

export interface PublicWebChatResultDto {
  /** Respuesta del asistente; vacía cuando atiende una persona (llegará después). */
  answer: string;
  /** Id del mensaje del asistente (para valorarlo), o null. */
  messageId: string | null;
  /** `human`: la conversación la atiende el equipo y la IA ya no responde. */
  mode: WebChatMode;
  /** El visitante dejó sus datos y se creó un contacto. */
  leadCaptured: boolean;
  /** No se pudo responder con IA: el visitante ha escrito demasiado hoy o el negocio gastó las del mes. */
  limited: 'visitor' | 'tenant' | null;
  /** Cómo contactar con el negocio (para cuando el chat no puede seguir). */
  contact: WebChatContactDto;
  /** Pedir ya sus datos (pidió una persona fuera del horario del equipo). */
  askContact?: boolean;
}

export type WebChatMode = 'ai' | 'human';
/** `system`: texto fijo del chat («Te paso con una persona…»), no una respuesta de la IA. */
export type WebChatRole = 'visitor' | 'assistant' | 'staff' | 'system';

export interface PublicWebChatMessageDto {
  id: string;
  role: WebChatRole;
  content: string;
  /** Valoración del visitante (solo respuestas del asistente). */
  rating: 1 | -1 | null;
  createdAt: string;
}

export interface PublicWebChatHistoryDto {
  messages: PublicWebChatMessageDto[];
  /** El visitante ya hizo hoy todas las preguntas que puede. */
  limited: 'visitor' | null;
  /** Contacto del negocio (para seguir por teléfono, WhatsApp o email). */
  contact: WebChatContactDto | null;
  mode: WebChatMode;
  /** Se pidió una persona y aún no ha respondido nadie: desde cuándo espera. */
  waitingSince: string | null;
  /** El visitante puede pedir hablar con una persona. */
  handoffEnabled: boolean;
  /** Preguntas para empezar (con los datos reales del negocio). */
  suggestions: string[];
  /** Ya dejó sus datos de contacto en esta conversación. */
  leadCaptured: boolean;
}

/** Consulta ligera del widget: ¿ha respondido alguien del equipo? */
export const PublicWebChatUpdatesSchema = z.object({
  visitorId: WebChatVisitorIdSchema,
  /** Fecha del último mensaje que ya ve el visitante. */
  after: z.string().datetime().optional(),
});
export type PublicWebChatUpdatesInput = z.infer<typeof PublicWebChatUpdatesSchema>;

export interface PublicWebChatUpdatesDto {
  /** Tiene conversación con movimiento en las últimas 24 horas. */
  active: boolean;
  mode: WebChatMode;
  /** Mensajes del equipo posteriores a `after` (los que aún no ha visto). */
  staffMessages: number;
}

export const PublicWebChatHandoffSchema = z.object({
  visitorId: WebChatVisitorIdSchema,
  locale: z.enum(['es', 'en']).default('es'),
  hp: z.string().max(200).optional(),
});
export type PublicWebChatHandoffInput = z.infer<typeof PublicWebChatHandoffSchema>;

export const PublicWebChatFeedbackSchema = z.object({
  visitorId: WebChatVisitorIdSchema,
  messageId: z.string().uuid(),
  rating: z.union([z.literal(1), z.literal(-1)]),
});
export type PublicWebChatFeedbackInput = z.infer<typeof PublicWebChatFeedbackSchema>;

/** Datos que deja el visitante cuando nadie del equipo puede atenderle. */
export const PublicWebChatContactSchema = z
  .object({
    visitorId: WebChatVisitorIdSchema,
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200).optional().or(z.literal('')),
    phone: z.string().trim().max(40).optional().or(z.literal('')),
    message: z.string().trim().max(1000).optional(),
    hp: z.string().max(200).optional(),
  })
  .refine((v) => !!v.email || (v.phone ?? '').replace(/\D/g, '').length >= 9, {
    message: 'Indica un email o un teléfono',
    path: ['email'],
  });
export type PublicWebChatContactInput = z.infer<typeof PublicWebChatContactSchema>;

/**
 * Reserva con el formulario del chat (sin pasar por la IA): los mismos datos
 * que la reserva online; la promoción activa se aplica sola.
 */
export const PublicWebChatBookingSchema = z.object({
  visitorId: WebChatVisitorIdSchema,
  locale: z.enum(['es', 'en']).default('es'),
  facilityId: z.string().uuid(),
  unitTypeId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customer: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s().-]{9,20}$/, 'Teléfono no válido'),
    documentNumber: z.string().trim().min(5).max(40),
  }),
  ...utmFields,
  clickIds: AdClickIdsSchema.optional(),
  hp: z.string().max(200).optional(),
});
export type PublicWebChatBookingInput = z.infer<typeof PublicWebChatBookingSchema>;

/** Empezar otra conversación (la anterior queda en el panel). */
export const PublicWebChatNewSchema = z.object({ visitorId: WebChatVisitorIdSchema });
export type PublicWebChatNewInput = z.infer<typeof PublicWebChatNewSchema>;

/** Probar el asistente desde Configuración (no se guarda nada ni hace reservas). */
export const WebChatTrySchema = z.object({
  message: z.string().trim().min(1).max(WEB_CHAT_MESSAGE_MAX),
  history: z
    .array(
      z.object({
        role: z.enum(['visitor', 'assistant']),
        content: z.string().max(2000),
      }),
    )
    .max(10)
    .default([]),
});
export type WebChatTryInput = z.infer<typeof WebChatTrySchema>;

export interface WebChatTryResultDto {
  answer: string;
  /** Lo que habría hecho el asistente (reserva, contacto, visita…), sin hacerlo. */
  actions: string[];
}

/** Respuesta del equipo al visitante (panel). */
export const WebChatStaffReplySchema = z.object({
  body: z.string().trim().min(1).max(2000),
});
export type WebChatStaffReplyInput = z.infer<typeof WebChatStaffReplySchema>;

export const UpdateWebChatConversationSchema = z
  .object({
    /** `ai` devuelve la conversación al asistente. */
    mode: z.enum(['ai', 'human']).optional(),
    /** Quién del equipo la lleva (null la deja sin responsable). */
    assignedToUserId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.mode !== undefined || v.assignedToUserId !== undefined, {
    message: 'Nada que cambiar',
  });
export type UpdateWebChatConversationInput = z.infer<typeof UpdateWebChatConversationSchema>;

/** Conversaciones en las que el visitante espera a una persona (para el menú). */
export interface WebChatPendingDto {
  /** Conversaciones esperando a una persona. */
  waiting: number;
  /** Mensajes de visitantes sin leer. */
  unread: number;
  /** Conversaciones que piden atención (esperan o tienen mensajes sin leer): el contador del menú. */
  conversations: number;
}

/** Configuración → Asistente IA → Chat de la web. */
export interface WebChatSettingsDto {
  /** El tenant tiene el asistente IA (plan o extra). */
  available: boolean;
  enabled: boolean;
  instructions: string | null;
  /** Puede preparar reservas y apuntar a la lista de espera. */
  bookingsEnabled: boolean;
  /** El visitante puede pedir hablar con una persona. */
  handoffEnabled: boolean;
  /** Usa las indicaciones del asistente de WhatsApp. */
  sharedInstructions: boolean;
  /** El negocio tiene indicaciones en el asistente de WhatsApp. */
  whatsappInstructions: string | null;
  /** Respuestas del mes con la IA de TrasterOS y su límite. */
  month: string;
  used: number;
  limit: number;
  resetsOn: string;
  /** Va con la clave de IA del propio negocio: sin límite de respuestas. */
  ownKey: boolean;
  /** Horario del equipo (null = siempre): fuera de él, pedir una persona avisa y pide los datos. */
  teamHours: OpeningHours | null;
}

export const UpdateWebChatSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** Indicaciones para el asistente de la web; `''` las quita. */
  instructions: z.string().trim().max(2000).optional(),
  bookingsEnabled: z.boolean().optional(),
  handoffEnabled: z.boolean().optional(),
  sharedInstructions: z.boolean().optional(),
  /** Horario del equipo; null lo quita (siempre disponible). */
  teamHours: OpeningHoursSchema.nullable().optional(),
});
export type UpdateWebChatSettingsInput = z.infer<typeof UpdateWebChatSettingsSchema>;

export interface WebChatConversationDto {
  id: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  locale: string;
  pagePath: string | null;
  leadId: string | null;
  leadName: string | null;
  /** Primer mensaje del visitante. */
  preview: string;
  /** Veces que no se pudo responder con IA (límite, sin clave o error). */
  fallbackCount: number;
  mode: WebChatMode;
  /** Pidió una persona y aún no le ha respondido nadie. */
  waitingSince: string | null;
  handoffSummary: string | null;
  /** Mensajes del visitante sin leer por el equipo. */
  staffUnread: number;
  /** Reserva hecha en el chat o en la web después de chatear. */
  contractId: string | null;
  bookedInChat: boolean;
  /** Quién del equipo la lleva. */
  assignedToUserId: string | null;
  assignedToName: string | null;
}

export interface WebChatMessageDto {
  id: string;
  role: WebChatRole;
  content: string;
  /** Respuesta de respaldo, sin IA. */
  fallback: boolean;
  /** El asistente no tenía la información. */
  unanswered: boolean;
  rating: 1 | -1 | null;
  /** Persona del equipo que respondió. */
  senderName: string | null;
  createdAt: string;
}

export interface WebChatStatsDto {
  days: number;
  conversations: number;
  visitorMessages: number;
  /** Respuestas del asistente con IA. */
  assistantReplies: number;
  /** Veces que no se pudo responder con IA (límite, sin clave o error). */
  fallbackReplies: number;
  /** Contactos distintos que dejaron sus datos. */
  leads: number;
  /** Reservas preparadas en el propio chat. */
  bookingsInChat: number;
  /** Visitantes que chatearon y luego reservaron en la web. */
  bookedAfterChat: number;
  /** De las reservas anteriores, las ya firmadas. */
  signedBookings: number;
  /** Con el primer pago cobrado. */
  paidBookings: number;
  /** Cobrado en esos primeros pagos (sin IVA ni devoluciones; 0 sin permiso). */
  revenue: number;
  /** Visitas al local pedidas en el chat. */
  visitsRequested: number;
  /** Veces que pidieron hablar con una persona. */
  handoffs: number;
  ratingsUp: number;
  ratingsDown: number;
  /** Preguntas que el asistente no supo responder (para añadirlas a las preguntas frecuentes). */
  unansweredQuestions: { question: string; count: number }[];
  /** Preguntas que más se repiten (para añadirlas a las preguntas frecuentes). */
  topQuestions: { question: string; count: number }[];
  /** Respuestas que el visitante marcó con 👎 (las últimas), con su pregunta. */
  badlyRated: { conversationId: string; question: string; answer: string; at: string }[];
}

/** Normaliza una pregunta para agruparla (minúsculas, sin acentos ni signos). */
export function normalizeWebChatQuestion(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
