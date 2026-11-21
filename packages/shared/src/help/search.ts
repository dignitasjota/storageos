import type { HelpTopic } from './topics';

/** Sin tildes y en minúsculas, para comparar. */
export function normalizeHelpText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Singular aproximado: «usuarios» encuentra «usuario», «remesas» encuentra «remesa». */
export function stemHelpWord(word: string): string {
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Palabras de una búsqueda, ya normalizadas. */
export function helpSearchWords(query: string): string[] {
  return normalizeHelpText(query)
    .split(/[^a-z0-9ñ*]+/)
    .filter(Boolean);
}

/** Todo el texto de la guía en el que se busca. */
function haystackOf(topic: HelpTopic): string {
  return normalizeHelpText(
    [
      topic.title,
      topic.summary,
      topic.keywords ?? '',
      ...topic.steps,
      ...topic.links.map((l) => l.label),
    ].join(' '),
  );
}

function wordIn(haystack: string, word: string): boolean {
  return haystack.includes(word) || haystack.includes(stemHelpWord(word));
}

/** La guía tiene todas las palabras (o su singular). */
export function helpTopicMatches(topic: HelpTopic, words: string[]): boolean {
  const haystack = haystackOf(topic);
  return words.every((w) => wordIn(haystack, w));
}

/** Guías que encuentra el buscador de «Cómo funciona» (todas sin búsqueda). */
export function searchHelpTopics<T extends HelpTopic>(topics: T[], query: string): T[] {
  const words = helpSearchWords(query);
  return words.length === 0 ? topics : topics.filter((t) => helpTopicMatches(t, words));
}

/** Palabras que no dicen de qué trata un texto libre. */
const STOP_WORDS = new Set([
  'para',
  'como',
  'cuando',
  'donde',
  'porque',
  'pero',
  'esta',
  'este',
  'estos',
  'estas',
  'esto',
  'sobre',
  'desde',
  'hasta',
  'todo',
  'todos',
  'tiene',
  'tengo',
  'puedo',
  'puede',
  'hacer',
  'quiero',
  'necesito',
  'problema',
  'ayuda',
  'favor',
  'hola',
  'gracias',
  'algo',
  'nada',
  'otra',
  'otro',
  'cual',
  'sale',
  'funciona',
  'error',
]);

/**
 * Guías relacionadas con un texto libre (el asunto de un ticket, una duda):
 * mismas reglas que el buscador por palabra, pero basta con que coincidan
 * algunas; primero las que tienen más palabras y en el título.
 */
export function relatedHelpTopics<T extends HelpTopic>(topics: T[], text: string, limit = 3): T[] {
  const words = [...new Set(helpSearchWords(text))].filter(
    (w) => w.length >= 4 && !STOP_WORDS.has(w),
  );
  if (words.length === 0) return [];
  const scored = topics
    .map((topic, index) => {
      const haystack = haystackOf(topic);
      const title = normalizeHelpText(`${topic.title} ${topic.keywords ?? ''}`);
      let score = 0;
      for (const w of words) {
        if (!wordIn(haystack, w)) continue;
        score += wordIn(title, w) ? 2 : 1;
      }
      return { topic, score, index };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.topic);
}

export interface HelpHighlightPart {
  text: string;
  match: boolean;
}

/**
 * Trocea un texto para resaltar las palabras buscadas (o su singular), sin
 * distinguir tildes ni mayúsculas. Sin palabras, una sola parte sin resaltar.
 */
export function helpHighlightParts(text: string, words: string[]): HelpHighlightPart[] {
  const terms = [...new Set(words.flatMap((w) => [w, stemHelpWord(w)]))].filter(
    (t) => t.length >= 2,
  );
  if (terms.length === 0 || text.length === 0) return [{ text, match: false }];

  // Texto normalizado con, para cada carácter, su posición en el original.
  let norm = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeHelpText(text[i]!);
    for (const ch of piece) {
      norm += ch;
      origin.push(i);
    }
  }

  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = norm.indexOf(term);
    while (from !== -1) {
      const start = origin[from]!;
      const end = origin[from + term.length - 1]!;
      for (let i = start; i <= end; i++) marked[i] = true;
      from = norm.indexOf(term, from + term.length);
    }
  }

  const parts: HelpHighlightPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.match === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, match: marked[i]! });
  }
  return parts;
}
