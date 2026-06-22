import { Injectable } from '@nestjs/common';

import { type AiCompletion, type AiMessageParam, AiProvider } from './ai-provider';

/**
 * Provider de IA simulado (sin API key). Determinista: según el texto del último
 * mensaje del usuario decide si invocar una herramienta, y al recibir el
 * resultado responde con un texto. Permite dev/test/CI sin coste ni clave.
 */
@Injectable()
export class StubAiProvider extends AiProvider {
  readonly available = true;

  createMessage(args: { messages: AiMessageParam[] }): Promise<AiCompletion> {
    const last = args.messages[args.messages.length - 1];

    // Si el último mensaje trae resultados de herramienta → responde con texto.
    if (last && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
      return Promise.resolve({
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: 'He consultado los datos del negocio y aquí tienes el resumen solicitado.',
          },
        ],
      });
    }

    const text = this.lastUserText(args.messages).toLowerCase();
    const tool = this.pickTool(text);
    if (tool) {
      return Promise.resolve({
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: `stub_${tool}`, name: tool, input: {} }],
      });
    }
    return Promise.resolve({
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: '[asistente en modo demo] Configura `AI_PROVIDER=anthropic` y `ANTHROPIC_API_KEY` para respuestas reales. Puedo ayudarte con ocupación, facturas vencidas, métricas y resúmenes de cliente.',
        },
      ],
    });
  }

  private lastUserText(messages: AiMessageParam[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === 'user' && typeof m.content === 'string') return m.content;
    }
    return '';
  }

  private pickTool(text: string): string | null {
    if (/(vencid|moros|impag)/.test(text)) return 'list_overdue_invoices';
    if (/(ocupaci|libres|disponibles|llen)/.test(text)) return 'get_occupancy';
    if (/(mrr|métric|metric|ingresos|negocio)/.test(text)) return 'get_business_metrics';
    return null;
  }
}
