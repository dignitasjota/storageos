import { z } from 'zod';

/**
 * Chat con IA en la web pública del tenant: lo usa un visitante anónimo, solo
 * con la información pública del negocio (locales, horarios, tamaños,
 * precios, promoción y preguntas frecuentes).
 */

/** Máximo de caracteres de un mensaje del visitante. */
export const WEB_CHAT_MESSAGE_MAX = 500;

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
  answer: string;
  /** El visitante dejó sus datos y se creó un contacto. */
  leadCaptured: boolean;
  /** No se pudo responder con IA: el visitante ha escrito demasiado hoy o el negocio gastó las del mes. */
  limited: 'visitor' | 'tenant' | null;
  /** Cómo contactar con el negocio (para cuando el chat no puede seguir). */
  contact: WebChatContactDto;
}

export interface PublicWebChatHistoryDto {
  messages: { role: 'visitor' | 'assistant'; content: string; createdAt: string }[];
}

/** Configuración → Asistente IA → Chat de la web. */
export interface WebChatSettingsDto {
  /** El tenant tiene el asistente IA (plan o extra). */
  available: boolean;
  enabled: boolean;
  instructions: string | null;
  /** Respuestas del mes con la IA de TrasterOS y su límite. */
  month: string;
  used: number;
  limit: number;
  resetsOn: string;
}

export const UpdateWebChatSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** Indicaciones para el asistente de la web; `''` las quita. */
  instructions: z.string().trim().max(2000).optional(),
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
}

export interface WebChatMessageDto {
  id: string;
  role: 'visitor' | 'assistant';
  content: string;
  createdAt: string;
}

export interface WebChatStatsDto {
  days: number;
  conversations: number;
  visitorMessages: number;
  assistantReplies: number;
  leads: number;
  /** Preguntas que más se repiten (para añadirlas a las preguntas frecuentes). */
  topQuestions: { question: string; count: number }[];
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
