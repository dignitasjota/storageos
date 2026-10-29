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

/** Tokens consumidos por una llamada (los devuelve el proveedor). */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiCompletion {
  stopReason: string;
  content: AiContentBlock[];
  /** Consumo de la llamada, si el proveedor lo informa. */
  usage?: AiUsage;
}

/**
 * Prompt de sistema. Con `{ stable, dynamic }`, la parte estable (reglas y
 * contexto que se repite en cada mensaje) se guarda en la caché de prompts de
 * Anthropic y la dinámica (fecha y hora, datos que cambian) va detrás sin caché.
 */
export type AiSystemPrompt = string | { stable: string; dynamic?: string };

/** El prompt de sistema como un solo texto (proveedores sin caché y el simulador). */
export function systemText(system: AiSystemPrompt): string {
  if (typeof system === 'string') return system;
  return system.dynamic ? `${system.stable}\n\n${system.dynamic}` : system.stable;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export abstract class AiProvider {
  /** ¿Está configurado y operativo? (p.ej. hay API key). */
  abstract readonly available: boolean;

  /** Modelo que se usa (para registrar el consumo). */
  abstract readonly modelName: string;

  abstract createMessage(args: {
    system: AiSystemPrompt;
    messages: AiMessageParam[];
    tools: AiToolDef[];
  }): Promise<AiCompletion>;

  /**
   * Como `createMessage`, pero va entregando el texto a `onText` según se
   * genera (streaming). Devuelve la respuesta completa al terminar. Por defecto
   * (stub y providers sin streaming) entrega el texto de una vez.
   */
  async streamMessage(
    args: { system: AiSystemPrompt; messages: AiMessageParam[]; tools: AiToolDef[] },
    onText: (delta: string) => void,
  ): Promise<AiCompletion> {
    const completion = await this.createMessage(args);
    for (const block of completion.content) {
      if (block.type === 'text' && block.text) onText(block.text);
    }
    return completion;
  }

  /**
   * El proveedor con otra clave y modelo (la clave propia de un tenant). Por
   * defecto el mismo (el de demostración no sale a la red).
   */
  forKey(_apiKey: string, _model: string, _maxTokens?: number): AiProvider {
    return this;
  }

  /**
   * La misma clave con otro modelo y otro tope de respuesta (el chat de la web
   * usa uno barato y respuestas cortas). Por defecto, el mismo provider.
   */
  forModel(_model: string, _maxTokens?: number): AiProvider {
    return this;
  }
}
