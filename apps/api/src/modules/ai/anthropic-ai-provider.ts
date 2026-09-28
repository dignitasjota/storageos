import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type AiCompletion,
  type AiContentBlock,
  type AiMessageParam,
  AiProvider,
  type AiToolDef,
} from './ai-provider';

import type { Env } from '../../config/env.schema';

/**
 * Provider de IA real contra la Messages API de Anthropic (vía `fetch`, sin SDK
 * para no añadir dependencia). Activo con `AI_PROVIDER=anthropic` +
 * `ANTHROPIC_API_KEY`.
 */
@Injectable()
export class AnthropicAiProvider extends AiProvider {
  private readonly logger = new Logger(AnthropicAiProvider.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.apiKey = config.get('ANTHROPIC_API_KEY', { infer: true }) ?? '';
    this.model = config.get('AI_MODEL', { infer: true }) ?? 'claude-sonnet-4-6';
  }

  get available(): boolean {
    return this.apiKey.length > 0;
  }

  private request(
    args: { system: string; messages: AiMessageParam[]; tools: AiToolDef[] },
    stream: boolean,
  ): Promise<Response> {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: args.system,
        tools: args.tools,
        messages: args.messages,
        ...(stream ? { stream: true } : {}),
      }),
    });
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    const body = await res.text();
    this.logger.error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
    throw new Error(`anthropic_api_error_${res.status}`);
  }

  async createMessage(args: {
    system: string;
    messages: AiMessageParam[];
    tools: AiToolDef[];
  }): Promise<AiCompletion> {
    const res = await this.request(args, false);
    await this.assertOk(res);
    const data = (await res.json()) as {
      stop_reason: string;
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
    };
    const content: AiContentBlock[] = data.content
      .filter((b) => b.type === 'text' || b.type === 'tool_use')
      .map((b) =>
        b.type === 'text'
          ? { type: 'text', text: b.text }
          : { type: 'tool_use', id: b.id, name: b.name, input: b.input },
      );
    return { stopReason: data.stop_reason, content };
  }

  /**
   * Streaming de la Messages API: eventos SSE `content_block_start` /
   * `content_block_delta` (`text_delta` o `input_json_delta`) /
   * `content_block_stop` / `message_delta` (con `stop_reason`). Se entrega el
   * texto a `onText` según llega y se reconstruyen los bloques completos.
   */
  override async streamMessage(
    args: { system: string; messages: AiMessageParam[]; tools: AiToolDef[] },
    onText: (delta: string) => void,
  ): Promise<AiCompletion> {
    const res = await this.request(args, true);
    await this.assertOk(res);
    if (!res.body) throw new Error('anthropic_stream_without_body');

    const accumulator = new AnthropicStreamAccumulator(onText);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        accumulator.handleEvent(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
    if (buffer.trim()) accumulator.handleEvent(buffer);
    return accumulator.result();
  }
}

const MAX_TOKENS = 2048;

type PartialBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string };

/**
 * Reconstruye la respuesta a partir de los eventos SSE de Anthropic. Exportado
 * para testearlo sin red.
 */
export class AnthropicStreamAccumulator {
  private readonly blocks = new Map<number, PartialBlock>();
  private stopReason = 'end_turn';

  constructor(private readonly onText: (delta: string) => void) {}

  /** Un evento SSE (líneas `event:`/`data:` separadas por salto de línea). */
  handleEvent(raw: string): void {
    const dataLine = raw
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5)
      .trim();
    if (!dataLine) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(dataLine) as Record<string, unknown>;
    } catch {
      return;
    }
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'text') this.blocks.set(index, { type: 'text', text: '' });
        if (block?.type === 'tool_use') {
          this.blocks.set(index, {
            type: 'tool_use',
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            json: '',
          });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        const block = this.blocks.get(index);
        if (!delta || !block) break;
        if (delta.type === 'text_delta' && block.type === 'text') {
          const text = String(delta.text ?? '');
          block.text += text;
          if (text) this.onText(text);
        }
        if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          block.json += String(delta.partial_json ?? '');
        }
        break;
      }
      case 'message_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') this.stopReason = delta.stop_reason;
        break;
      }
      case 'error': {
        const err = event.error as Record<string, unknown> | undefined;
        throw new Error(`anthropic_stream_error_${String(err?.type ?? 'unknown')}`);
      }
      default:
        break;
    }
  }

  result(): AiCompletion {
    const content: AiContentBlock[] = [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        let input: Record<string, unknown> = {};
        try {
          input = b.json ? (JSON.parse(b.json) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        return { type: 'tool_use', id: b.id, name: b.name, input };
      });
    return { stopReason: this.stopReason, content };
  }
}
