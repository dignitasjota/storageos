import type { AiCompletion } from './ai-provider';

/** Marca del prompt del borrador de una entrada del blog (el simulador responde un JSON). */
export const BLOG_POST_DRAFT_MARKER = 'Redactas entradas de blog';

/** Marca del prompt del borrador de una landing de promoción (el simulador responde un JSON). */
export const PROMO_LANDING_DRAFT_MARKER = 'Redactas landings de promoción';

function jsonReply(value: unknown): AiCompletion {
  return { stopReason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] };
}

const BLOG_POST_DRAFT_STUB = jsonReply({
  title: 'Cómo elegir el tamaño de tu trastero (demo)',
  excerpt: 'Borrador de demostración. Configura la IA para textos reales.',
  contentMarkdown: [
    '## Qué cabe en cada tamaño',
    '',
    'Texto de demostración de la entrada redactado en modo demo. '.repeat(4).trim(),
    '',
    '[[tamanos]]',
    '',
    '## Calcula tu espacio',
    '',
    '[[calculadora]]',
  ].join('\n'),
  seoTitle: 'Cómo elegir trastero (demo)',
  seoDescription: 'Borrador de demostración de una entrada del blog.',
});

const PROMO_LANDING_DRAFT_STUB = jsonReply({
  headline: 'Primer mes gratis en tu trastero (demo)',
  subheadline: 'Borrador de demostración. Configura la IA para textos reales.',
  benefits: [
    { title: 'Acceso fácil', description: 'Texto de demostración.' },
    { title: 'Sin papeleo', description: 'Texto de demostración.' },
  ],
  conditions: ['Promoción de demostración.', 'Consulta las condiciones reales.'],
  seoTitle: 'Primer mes gratis (demo)',
  seoDescription: 'Borrador de demostración de una landing de promoción.',
});

/** Respuesta simulada de los borradores de la web (blog y landings), o null si no es uno. */
export function webDraftStub(system: string): AiCompletion | null {
  if (system.includes(BLOG_POST_DRAFT_MARKER)) return BLOG_POST_DRAFT_STUB;
  if (system.includes(PROMO_LANDING_DRAFT_MARKER)) return PROMO_LANDING_DRAFT_STUB;
  return null;
}
