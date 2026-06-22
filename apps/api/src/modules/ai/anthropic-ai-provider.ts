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

  async createMessage(args: {
    system: string;
    messages: AiMessageParam[];
    tools: AiToolDef[];
  }): Promise<AiCompletion> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: args.system,
        tools: args.tools,
        messages: args.messages,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
      throw new Error(`anthropic_api_error_${res.status}`);
    }
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
}
