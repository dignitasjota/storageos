import { ApiError, apiFetchResponse } from '../auth/api';

import type { ChatInput, ChatResultDto } from '@storageos/shared';

export interface AiStreamHandlers {
  /** Trozo de la respuesta según la escribe el modelo. */
  onText: (delta: string) => void;
  /** El modelo consulta una herramienta (el texto previo de esa vuelta se descarta). */
  onTool: (name: string) => void;
}

/**
 * Chat del asistente en streaming (`POST /ai/chat/stream`, Server-Sent Events).
 * Resuelve con el resultado final (conversación + mensaje guardado) y lanza
 * `ApiError` si el servidor responde con error antes o durante el stream.
 */
export async function streamAiChat(
  input: ChatInput,
  handlers: AiStreamHandlers,
): Promise<ChatResultDto> {
  const res = await apiFetchResponse('/ai/chat/stream', { method: 'POST', json: input });
  if (!res.body) throw new Error('stream_not_supported');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ChatResultDto | null = null;

  const handle = (block: string) => {
    const line = block
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5)
      .trim();
    if (!line) return;
    const event = JSON.parse(line) as {
      type: string;
      delta?: string;
      name?: string;
      code?: string;
      message?: string;
    } & Partial<ChatResultDto>;
    if (event.type === 'text' && event.delta) handlers.onText(event.delta);
    else if (event.type === 'tool' && event.name) handlers.onTool(event.name);
    else if (event.type === 'done' && event.conversationId && event.message) {
      result = { conversationId: event.conversationId, message: event.message };
    } else if (event.type === 'error') {
      throw new ApiError({
        statusCode: 500,
        error: event.code ?? 'ai_stream_failed',
        message: event.message ?? 'No se pudo completar la respuesta.',
      });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      handle(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
  if (!result) throw new Error('stream_incomplete');
  return result;
}
