import { z } from 'zod';

export const ChatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(4000),
});
export type ChatInput = z.infer<typeof ChatSchema>;

export interface AiMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Herramientas que consultó el asistente para responder (transparencia). */
  toolsUsed: string[] | null;
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
