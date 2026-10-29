import { Injectable } from '@nestjs/common';

import {
  type AiCompletion,
  type AiMessageParam,
  AiProvider,
  type AiSystemPrompt,
  systemText,
} from './ai-provider';

/** Comienzo del prompt del chat de la web pública (el simulador responde como él). */
export const WEB_CHAT_PROMPT_MARKER = 'Eres el asistente virtual de la web de';

/** Marca del prompt de borrador de página de zona (el simulador responde un JSON). */
export const AREA_PAGE_DRAFT_MARKER = 'Redactas páginas de zona';

const AREA_PAGE_DRAFT_STUB: AiCompletion = {
  stopReason: 'end_turn',
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        intro: Array.from(
          { length: 14 },
          () => 'Texto de demostración de la página de zona redactado en modo demo.',
        ).join(' '),
        nearestNote: 'Nuestro local más cercano está a pocos minutos en coche.',
        nearbyAreas: ['Zona norte', 'Zona sur'],
        faqs: [{ question: '¿Puedo entrar con furgoneta?', answer: 'Sí, hasta la puerta.' }],
        seoTitle: 'Trasteros en la zona (demo)',
        seoDescription: 'Borrador de demostración. Configura la IA para textos reales.',
      }),
    },
  ],
};

/**
 * Provider de IA simulado (sin API key). Determinista: según el texto del último
 * mensaje del usuario decide si invocar una herramienta, y al recibir el
 * resultado responde con un texto. Permite dev/test/CI sin coste ni clave.
 */
@Injectable()
export class StubAiProvider extends AiProvider {
  readonly available = true;
  readonly modelName = 'stub';

  /** Respuesta simulada + consumo aproximado (≈4 caracteres por token). */
  async createMessage(args: {
    system?: AiSystemPrompt;
    messages: AiMessageParam[];
    tools?: unknown[];
  }): Promise<AiCompletion> {
    const system = args.system ? systemText(args.system) : '';
    const completion = system.includes(AREA_PAGE_DRAFT_MARKER)
      ? AREA_PAGE_DRAFT_STUB
      : system.startsWith(WEB_CHAT_PROMPT_MARKER)
        ? this.webChat(args.messages)
        : await this.respond(args);
    const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
    const inputTokens = tokens(JSON.stringify(args.messages));
    const outputTokens = tokens(JSON.stringify(completion.content));
    return { ...completion, usage: { inputTokens, outputTokens } };
  }

  private respond(args: { messages: AiMessageParam[]; tools?: unknown[] }): Promise<AiCompletion> {
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
    // Sin herramientas disponibles (llamada single-shot, p. ej. sugerir respuesta)
    // → nunca emite tool_use; responde directamente con texto.
    const tool = args.tools && args.tools.length > 0 ? this.pickTool(text) : null;
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

  /** Chat de la web: si el visitante deja un email, lo guarda como contacto. */
  private webChat(messages: AiMessageParam[]): AiCompletion {
    const text = this.lastUserText(messages);
    const reply = (t: string): AiCompletion => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: t }],
    });
    // «reservar {json}» / «espera {json}» → la marca con esos datos (pruebas).
    const booking = /^reservar\s+(\{[\s\S]*\})$/i.exec(text.trim());
    if (booking) return reply(`Perfecto, te lo preparo.\n[[RESERVA ${booking[1]}]]`);
    const waiting = /^espera\s+(\{[\s\S]*\})$/i.exec(text.trim());
    if (waiting) return reply(`Te apunto.\n[[ESPERA ${waiting[1]}]]`);
    if (/persona|humano/i.test(text)) {
      return reply('Te paso con una persona del equipo.\n[[HUMANO]]');
    }
    if (/aparcamiento|parking/i.test(text)) {
      return reply('No tengo esa información; escríbenos y te lo confirmamos.\n[[SIN_RESPUESTA]]');
    }
    const email = /[^\s@]+@[^\s@]+\.[^\s@]+/.exec(text)?.[0];
    const phone = /llam/i.test(text) ? /\d[\d\s]*/.exec(text)?.[0]?.trim() : undefined;
    return {
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: email
            ? `¡Gracias! El equipo te escribirá pronto.\n[[CONTACTO {"nombre":"Visitante","email":"${email}","mensaje":"Quiere información"}]]`
            : phone
              ? `¡Gracias! El equipo te llamará pronto.\n[[CONTACTO {"nombre":"Visitante","telefono":"${phone}"}]]`
              : 'Hola, soy el asistente de la web. Tenemos trasteros de varios tamaños; dime qué necesitas guardar y te digo cuál te encaja.',
        },
      ],
    };
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
