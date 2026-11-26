import { ApiError, apiFetchResponse } from '../auth/api';

import type { ChatInput, ChatResultDto } from '@storageos/shared';

export interface AiStreamHandlers {
  /** Trozo de la respuesta según la escribe el modelo. */
  onText: (delta: string) => void;
  /** El modelo consulta una herramienta (el texto previo de esa vuelta se descarta). */
  onTool: (name: string) => void;
  /** La conversación de la pregunta, en cuanto el servidor la conoce. */
  onStart?: (conversationId: string) => void;
}

/**
 * Chat del asistente en streaming (`POST /ai/chat/stream`, Server-Sent Events).
 * Resuelve con el resultado final (conversación + mensaje guardado) y lanza
 * `ApiError` si el servidor responde con error antes o durante el stream.
 */
/**
 * La petición no llegó a salir (sin red, navegador sin streaming): el servidor
 * no ha recibido nada y se puede repetir por la vía normal sin duplicar.
 */
export class AiStreamUnavailableError extends Error {
  constructor() {
    super('stream_unavailable');
  }
}

/** El usuario pulsó «Detener». */
export class AiStreamStoppedError extends Error {
  constructor() {
    super('stream_stopped');
  }
}

export async function streamAiChat(
  input: ChatInput,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<ChatResultDto> {
  let res: Response;
  try {
    res = await apiFetchResponse('/ai/chat/stream', {
      method: 'POST',
      json: input,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) throw new AiStreamStoppedError();
    if (err instanceof ApiError) throw err;
    throw new AiStreamUnavailableError();
  }
  return readAiChatStream<ChatResultDto>(res, handlers, signal);
}

/**
 * Lee la respuesta en streaming de un chat con IA (Server-Sent Events): el
 * asistente del panel y el de SEO usan los mismos eventos (`start`, `text`,
 * `tool`, `done`, `error`). Resuelve con el resultado final.
 */
export async function readAiChatStream<R extends { conversationId: string; message: unknown }>(
  res: Response,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<R> {
  // Con respuesta del servidor la pregunta ya está en marcha: un corte a partir
  // de aquí NO se reintenta (se preguntaría dos veces).
  if (!res.body) throw new Error('stream_not_supported');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: R | null = null;

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
    } & Partial<R>;
    if (event.type === 'start' && event.conversationId) handlers.onStart?.(event.conversationId);
    else if (event.type === 'text' && event.delta) handlers.onText(event.delta);
    else if (event.type === 'tool' && event.name) handlers.onTool(event.name);
    else if (event.type === 'done' && event.conversationId && event.message) {
      result = { conversationId: event.conversationId, message: event.message } as R;
    } else if (event.type === 'error') {
      throw new ApiError({
        statusCode: 500,
        error: event.code ?? 'ai_stream_failed',
        message: event.message ?? 'No se pudo completar la respuesta.',
      });
    }
  };

  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw new AiStreamStoppedError();
      throw err;
    }
    const { done, value } = chunk;
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
