import { z } from 'zod';

/** Ficha desde la que se pregunta («Preguntar al asistente»). */
export const AI_ABOUT_TYPES = [
  'customer',
  'contract',
  'invoice',
  'unit',
  'facility',
  'lead',
] as const;
export type AiAboutType = (typeof AI_ABOUT_TYPES)[number];

export const ChatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(4000),
  /** La pregunta se hace desde esta ficha: «este inquilino» es ese. */
  about: z.object({ type: z.enum(AI_ABOUT_TYPES), id: z.string().uuid() }).optional(),
});
export type ChatInput = z.infer<typeof ChatSchema>;

export interface AiMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Herramientas que consultó el asistente para responder (transparencia). */
  toolsUsed: string[] | null;
  /** Acciones que el asistente propuso en este mensaje (el usuario las confirma o descarta). */
  actions?: AiPendingActionDto[];
  createdAt: string;
}

/** Tipos de acción que el asistente puede proponer (nunca ejecuta sin confirmación). */
export const AI_ACTION_TYPES = [
  'create_task',
  'payment_reminder',
  'customer_message',
  'customer_note',
  'customer_followup',
] as const;
export type AiActionType = (typeof AI_ACTION_TYPES)[number];

export type AiActionStatus =
  | 'proposed'
  | 'executing'
  | 'confirmed'
  | 'discarded'
  | 'failed'
  /** Propuesta de hace más de 7 días sin confirmar: ya no se puede confirmar. */
  | 'expired';

export interface AiPendingActionDto {
  id: string;
  type: AiActionType;
  /** Descripción legible de lo que se hará al confirmar. */
  summary: string;
  /** Texto completo que se enviará o guardará (el resumen lo recorta). */
  details: string | null;
  status: AiActionStatus;
  /** Tras confirmar: enlace al recurso creado o motivo del fallo. */
  resultLink: string | null;
  resultError: string | null;
  createdAt: string;
}

export interface AiConversationDto {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationDetailDto extends AiConversationDto {
  messages: AiMessageDto[];
}

export interface ChatResultDto {
  conversationId: string;
  message: AiMessageDto;
}

/** Sugerir una respuesta de staff en el chat con un inquilino (IA, no envía). */
export const SuggestReplySchema = z.object({
  customerId: z.string().uuid(),
});
export type SuggestReplyInput = z.infer<typeof SuggestReplySchema>;

export interface SuggestReplyResultDto {
  suggestion: string;
}

/** Chatbot de autoservicio del portal del inquilino. */
export const PortalAiChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  /** Historial reciente (lo mantiene el cliente; no se persiste). */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(12)
    .optional(),
});
export type PortalAiChatInput = z.infer<typeof PortalAiChatSchema>;

export interface PortalAiChatResultDto {
  answer: string;
}
export * from './limits';
export * from './web-chat';

export const AiScheduleFrequencyEnum = z.enum(['daily', 'weekly']);

/** Pregunta que se hace sola cada día o cada semana y llega por correo. */
export const CreateAiScheduledQuestionSchema = z
  .object({
    question: z.string().trim().min(5).max(1000),
    frequency: AiScheduleFrequencyEnum,
    /** 1 (lunes) a 7 (domingo), si es semanal. */
    weekday: z.number().int().min(1).max(7).optional(),
    hour: z.number().int().min(0).max(23).default(8),
  })
  .refine((v) => v.frequency === 'daily' || v.weekday !== undefined, {
    message: 'Elige el día de la semana',
    path: ['weekday'],
  });
export type CreateAiScheduledQuestionInput = z.infer<typeof CreateAiScheduledQuestionSchema>;

export const UpdateAiScheduledQuestionSchema = z.object({
  isActive: z.boolean().optional(),
  hour: z.number().int().min(0).max(23).optional(),
});
export type UpdateAiScheduledQuestionInput = z.infer<typeof UpdateAiScheduledQuestionSchema>;

export interface AiScheduledQuestionDto {
  id: string;
  question: string;
  frequency: 'daily' | 'weekly';
  weekday: number | null;
  hour: number;
  isActive: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastConversationId: string | null;
  lastError: string | null;
}
