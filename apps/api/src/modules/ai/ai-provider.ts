/**
 * Abstracción del proveedor de IA (modelo de lenguaje con tool-use). La forma
 * sigue la Messages API de Anthropic, de modo que el provider real es fino y el
 * stub la imita. Selección por `AI_PROVIDER=stub|anthropic` (factory en el
 * módulo).
 */

export interface AiTextBlock {
  type: 'text';
  text: string;
}
export interface AiToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type AiContentBlock = AiTextBlock | AiToolUseBlock;

export interface AiToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface AiMessageParam {
  role: 'user' | 'assistant';
  content: string | Array<AiContentBlock | AiToolResultBlock>;
}

export interface AiToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AiCompletion {
  stopReason: string;
  content: AiContentBlock[];
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export abstract class AiProvider {
  /** ¿Está configurado y operativo? (p.ej. hay API key). */
  abstract readonly available: boolean;

  abstract createMessage(args: {
    system: string;
    messages: AiMessageParam[];
    tools: AiToolDef[];
  }): Promise<AiCompletion>;
}
