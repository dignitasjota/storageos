import { Injectable } from '@nestjs/common';
import { type WhatsappAiProvider, whatsappAiBaseUrl } from '@storageos/shared';

import { safePostJson } from '../../common/security/safe-http-post';

export interface WhatsappAiConfig {
  provider: WhatsappAiProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string;
}

export interface WhatsappAiTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface WhatsappAiCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export class WhatsappAiError extends Error {}

/** Marca con la que el asistente pide pasar la conversación a una persona. */
export const HANDOFF_MARKER = '[[HUMANO]]';

/** Marca con la que el asistente pide crear la reserva (JSON con los datos). */
export const BOOKING_MARKER_RE = /\[\[RESERVA\s*(\{[\s\S]*?\})\s*\]\]/;
/** Marca con la que el modelo indica el idioma del cliente (la quita el servidor). */
export const LANGUAGE_MARKER_RE = /\[\[IDIOMA\s+([a-z]{2})\s*\]\]/i;
/** Marca con la que el modelo indica qué busca el cliente (la quita el servidor). */
export const INTENT_MARKER_RE = /\[\[INTENCION\s+([a-z]+)\s*\]\]/i;

/**
 * Prompt de sistema: con `{ stable, dynamic }` la parte estable va a la caché
 * de prompts de Anthropic (los demás proveedores reciben el texto entero).
 */
export type WhatsappAiSystem = string | { stable: string; dynamic?: string };

function systemString(system: WhatsappAiSystem): string {
  if (typeof system === 'string') return system;
  return system.dynamic ? `${system.stable}\n\n${system.dynamic}` : system.stable;
}

const MAX_OUTPUT_TOKENS = 700;
const TIMEOUT_MS = 30_000;

/**
 * Cliente de la IA del asistente de WhatsApp (independiente de la IA del
 * panel). Anthropic por su API; OpenAI, MiniMax y «compatible con OpenAI» por
 * `/chat/completions`. Las llamadas van por `safePostJson`: la URL puede
 * ponerla el tenant, así que no se permiten destinos de la red interna.
 *
 * Con `NODE_ENV=test` o `WHATSAPP_BUSINESS_MODE=stub` responde simulado: si el
 * último mensaje pide una persona («humano»/«persona») devuelve la marca de
 * paso a una persona; si la clave empieza por `invalid`, falla.
 */
@Injectable()
export class WhatsappAiClient {
  get stub(): boolean {
    return process.env.WHATSAPP_BUSINESS_MODE === 'stub' || process.env.NODE_ENV === 'test';
  }

  async complete(
    config: WhatsappAiConfig,
    system: WhatsappAiSystem,
    turns: WhatsappAiTurn[],
  ): Promise<WhatsappAiCompletion> {
    if (this.stub) return this.stubComplete(config, turns);
    const base = whatsappAiBaseUrl(config.provider, config.baseUrl);
    if (!base) throw new WhatsappAiError('Falta la URL de la API del proveedor');
    if (!config.model) throw new WhatsappAiError('Falta el modelo');
    return config.provider === 'anthropic'
      ? this.anthropic(base, config, system, turns)
      : this.openaiFormat(base, config, systemString(system), turns);
  }

  private async anthropic(
    base: string,
    config: WhatsappAiConfig,
    system: WhatsappAiSystem,
    turns: WhatsappAiTurn[],
  ): Promise<WhatsappAiCompletion> {
    const cache = { type: 'ephemeral' } as const;
    const blocks =
      typeof system === 'string'
        ? [{ type: 'text', text: system, cache_control: cache }]
        : [
            { type: 'text', text: system.stable, cache_control: cache },
            ...(system.dynamic ? [{ type: 'text', text: system.dynamic }] : []),
          ];
    const json = await this.post(`${base}/messages`, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: blocks,
        messages: turns,
      },
    });
    const content = (json.content as { type?: string; text?: string }[] | undefined) ?? [];
    const usage =
      (json.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }) ?? {};
    return {
      text: content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n'),
      inputTokens:
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
    };
  }

  private async openaiFormat(
    base: string,
    config: WhatsappAiConfig,
    system: string,
    turns: WhatsappAiTurn[],
  ): Promise<WhatsappAiCompletion> {
    const json = await this.post(`${base}/chat/completions`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: {
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'system', content: system }, ...turns],
      },
    });
    const choice = (json.choices as { message?: { content?: string } }[] | undefined)?.[0];
    const usage = (json.usage as { prompt_tokens?: number; completion_tokens?: number }) ?? {};
    return {
      // Algunos modelos razonadores (p. ej. MiniMax) incluyen su razonamiento.
      text: (choice?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, ''),
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  }

  private async post(
    url: string,
    args: { headers: Record<string, string>; body: unknown },
  ): Promise<Record<string, unknown>> {
    let res: { status: number; text: string };
    try {
      res = await safePostJson({
        url,
        headers: { 'Content-Type': 'application/json', ...args.headers },
        body: JSON.stringify(args.body),
        timeoutMs: TIMEOUT_MS,
        maxResponseBytes: 1_000_000,
      });
    } catch (err) {
      throw new WhatsappAiError(
        `No se pudo conectar con el proveedor de IA: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      /* respuesta no JSON */
    }
    if (res.status < 200 || res.status >= 300) {
      const err = json.error as { message?: string } | string | undefined;
      const detail = typeof err === 'string' ? err : err?.message;
      throw new WhatsappAiError(
        `El proveedor de IA respondió ${res.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return json;
  }

  private stubComplete(config: WhatsappAiConfig, turns: WhatsappAiTurn[]): WhatsappAiCompletion {
    if (config.apiKey.startsWith('invalid')) {
      throw new WhatsappAiError('El proveedor de IA respondió 401: clave no válida (simulado)');
    }
    const last = [...turns].reverse().find((t) => t.role === 'user')?.content ?? '';
    // «reservar {json}» → la marca de reserva con esos datos (para las pruebas).
    const booking = /^reservar\s+(\{[\s\S]*\})$/i.exec(last.trim());
    const english = /\b(hello|hi|how much|price|please|thanks|storage unit)\b/i.test(last);
    // Resumen para el equipo (prompt de resumen): texto fijo.
    if (last.startsWith('RESUMEN:')) {
      return {
        text: 'Busca un trastero y quiere hablar con el equipo.',
        inputTokens: 50,
        outputTokens: 10,
      };
    }
    const intent = /reclam|queja/i.test(last)
      ? 'reclamacion'
      : /precio|cu[aá]nto|price|how much/i.test(last)
        ? 'precio'
        : /baja/i.test(last)
          ? 'baja'
          : 'otro';
    const text = `[[IDIOMA ${english ? 'en' : 'es'}]] [[INTENCION ${intent}]] ${
      booking
        ? `Perfecto, te lo preparo. [[RESERVA ${booking[1]}]]`
        : /humano|persona/i.test(last)
          ? `Te paso con una persona del equipo, enseguida te escriben. ${HANDOFF_MARKER}`
          : `Respuesta automática (simulada): ${last.slice(0, 80)}`
    }`;
    return { text, inputTokens: 100, outputTokens: 20 };
  }
}
