import type { AiCompletion, AiMessageParam } from './ai-provider';

/** Comienzo del prompt del asistente de SEO (el simulador responde como él). */
export const SEO_ASSISTANT_PROMPT_MARKER = 'Eres el asistente de SEO de TrasterOS';

/** Marca del prompt de los briefs de contenido (el simulador responde un JSON). */
export const SEO_BRIEF_PROMPT_MARKER = 'Preparas briefs de contenido SEO';

const text = (t: string): AiCompletion => ({
  stopReason: 'end_turn',
  content: [{ type: 'text', text: t }],
});

const SEO_BRIEF_STUB = text(
  JSON.stringify({
    intent: 'Contratar: quiere alquilar un trastero cerca (demo).',
    objective: 'Que la página consiga reservas desde Google (demo).',
    h1: 'Trasteros de alquiler cerca de ti (demo)',
    proposedUrl: '/trasteros-demo',
    outline: [
      { level: 2, text: 'Tamaños y precios' },
      { level: 3, text: 'Trasteros pequeños' },
      { level: 3, text: 'Trasteros grandes' },
      { level: 2, text: 'Cómo reservar' },
      { level: 2, text: 'Horario y acceso' },
    ],
    questions: ['¿Cuánto cuesta un trastero al mes?'],
    faqs: [
      { question: '¿Puedo entrar con el coche?', answer: 'Texto de demostración.' },
      { question: '¿Hay que pagar fianza?', answer: '' },
    ],
    metaProposals: [
      {
        title: 'Trasteros de alquiler cerca de ti (demo)',
        description:
          'Borrador de demostración. Configura la IA para propuestas reales de descripción.',
      },
      {
        title: 'Alquiler de trasteros: tamaños y precios (demo)',
        description: 'Borrador de demostración de una descripción para Google con el tamaño justo.',
      },
      {
        title: 'Trasteros baratos y seguros (demo)',
        description: 'Descripción de demostración.',
      },
    ],
    verify: ['Los precios y horarios son los de la web del negocio: compruébalos.'],
  }),
);

function lastUserText(messages: AiMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

const PROPOSALS: Record<string, string> = {
  tarea: 'seo_propose_task',
  actuacion: 'seo_propose_change',
  actuación: 'seo_propose_change',
  oportunidad: 'seo_propose_opportunity',
  palabra: 'seo_propose_follow_keyword',
};

/** Herramienta de lectura según la pregunta (como el simulador del asistente del panel). */
function pickReadTool(t: string): string | null {
  if (/competid|competencia/.test(t)) return 'seo_competitors';
  if (/resultados de google|serp/.test(t)) return 'seo_serp';
  if (/canibaliz|indexa/.test(t)) return 'seo_diagnostics';
  if (/rastreo|rastread/.test(t)) return 'seo_crawl';
  if (/velocidad|inspecci/.test(t)) return 'seo_technical';
  if (/conversi|reservas/.test(t)) return 'seo_conversions';
  if (/tarea|actuaci/.test(t)) return 'seo_plan';
  if (/oportunidad|primero/.test(t)) return 'seo_opportunities';
  if (/ca[ií]d|bajan|baja|suben|cambi/.test(t)) return 'seo_changes';
  if (/resumen|periodo|vamos/.test(t)) return 'seo_summary';
  return null;
}

/**
 * Respuestas simuladas del asistente de SEO y de los briefs (dev, tests y CI,
 * sin coste ni red). Determinista: según la pregunta consulta una herramienta
 * de lectura y, al recibir el resultado, responde un texto fijo. Con
 * «propón <tarea|actuación|oportunidad|palabra> {json}» prepara esa acción.
 * Nunca sigue lo que venga dentro de los resultados de las herramientas.
 */
export function seoAssistantStub(
  system: string,
  messages: AiMessageParam[],
  tools: unknown[] | undefined,
): AiCompletion | null {
  if (system.includes(SEO_BRIEF_PROMPT_MARKER)) return SEO_BRIEF_STUB;
  if (!system.startsWith(SEO_ASSISTANT_PROMPT_MARKER)) return null;
  const offered = new Set(
    (tools ?? []).map((t) => (t as { name?: string }).name).filter((n): n is string => !!n),
  );
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
    const prev = messages[messages.length - 2];
    const proposed =
      prev &&
      Array.isArray(prev.content) &&
      prev.content.some((b) => b.type === 'tool_use' && b.name.startsWith('seo_propose_'));
    return text(
      proposed
        ? 'Lo he dejado preparado: revísalo y confírmalo abajo si te parece bien.'
        : 'He consultado los datos de SEO del proyecto (Search Console, con su fecha). [respuesta de demostración]',
    );
  }
  const raw = lastUserText(messages).trim();
  const proposal = /^prop[oó]n\s+(\S+)\s+(\{[\s\S]*\})$/i.exec(raw);
  if (proposal) {
    const name = PROPOSALS[proposal[1]!.toLowerCase()];
    if (name && offered.has(name)) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(proposal[2]!) as Record<string, unknown>;
      } catch {
        input = {};
      }
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: `stub_${name}`, name, input }],
      };
    }
    return text('No puedo preparar esa acción: no tienes permiso para cambiar este proyecto.');
  }
  const tool = pickReadTool(raw.toLowerCase());
  if (tool && offered.has(tool)) {
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `stub_${tool}`, name: tool, input: {} }],
    };
  }
  return text(
    '[asistente de SEO en modo demo] Pregúntame por el resumen del periodo, lo que baja, las oportunidades, la competencia o el rastreo.',
  );
}
