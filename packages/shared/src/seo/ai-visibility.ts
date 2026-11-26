import { z } from 'zod';

import type { SeoAlertCandidate } from './alerts';
import type { SeoDataOriginDto } from './sistrix';

/**
 * SEO Avanzado, PR 12: visibilidad en buscadores de IA (ChatGPT, AI Overviews
 * y AI Mode de Google) con `ai_check` de SISTRIX. Lo puro: claves, modelos,
 * los prompts en los que sale la competencia y tú no, y la alerta cuando
 * desapareces de prompts en los que salías.
 *
 * Las respuestas de las IA son texto de terceros: se guardan tal cual, se
 * enseñan como texto (sin enlaces activos ni HTML) y al asistente le llegan
 * delimitadas como dato.
 */

/** País de las consultas de IA: siempre España. */
export const SEO_AI_COUNTRY = 'es';
/** Prompts por consulta de la vista `prompts`. */
export const SEO_AI_PROMPTS_LIMIT = 50;
/** Fuentes por consulta de la vista `sources`. */
export const SEO_AI_SOURCES_LIMIT = 50;
/** Prompts que se pueden seguir por proyecto (cada uno, una consulta `ai_prompt_answers`). */
export const SEO_AI_TRACKED_PROMPTS_MAX = 20;
/** Lo que se guarda de cada respuesta (caracteres). */
export const SEO_AI_ANSWER_MAX = 4000;

export const SEO_AI_MODELS = ['aio', 'ai_mode', 'chatgpt'] as const;
export const SEO_AI_MODEL_LABELS: Record<string, string> = {
  aio: 'AI Overviews de Google',
  ai_mode: 'AI Mode de Google',
  aimode: 'AI Mode de Google',
  chatgpt: 'ChatGPT',
};
export const seoAiModelLabel = (m: string): string => SEO_AI_MODEL_LABELS[m] ?? (m || 'Sin modelo');
/** SISTRIX escribe «AI Mode» de dos formas según la vista: una sola. */
export const seoAiModel = (m: string | null | undefined): string => {
  const v = (m ?? '').trim().toLowerCase();
  return v === 'aimode' ? 'ai_mode' : v;
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '·',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      // Sin caracteres de control (salvo salto y tabulador) ni sustitutos sueltos.
      if (!Number.isFinite(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ' ';
      if ((n < 32 && n !== 9 && n !== 10) || (n >= 0x7f && n < 0xa0)) return ' ';
      return String.fromCodePoint(n);
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/**
 * La respuesta de una IA (SISTRIX la da en HTML: listas, `<highlight>` y
 * `<sup>` con números romanos de referencia) como texto plano limpio: cada
 * elemento de lista en su línea con guion, párrafos en líneas, sin las
 * referencias ni ninguna etiqueta, con las entidades decodificadas y los
 * espacios colapsados. Nunca se renderiza como HTML: el resultado se enseña
 * como texto (y lo que pareciera una etiqueta, se ve tal cual).
 */
export function seoAiAnswerText(raw: string | null | undefined, max = SEO_AI_ANSWER_MAX): string {
  if (!raw) return '';
  let t = String(raw)
    // Las referencias (I, II, …) y lo que no es texto.
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup\s*>/gi, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Listas a líneas con guion (las vacías, fuera); párrafos, saltos y bloques a líneas.
    .replace(/<li\b[^>]*>\s*<\/li\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|ul|ol|li|h[1-6]|tr|table|section|article|blockquote)\b[^>]*>/gi, '\n')
    // Cualquier otra etiqueta (highlight, a, b, span…), fuera.
    .replace(/<\/?[a-z][^>]*>/gi, '');
  t = decodeEntities(t).replace(CONTROL_CHARS, ' ');
  const raw2 = t
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l) => l !== '');
  // Un guion suelto («<li><p>…</p></li>») va con la línea siguiente; uno vacío, fuera.
  const lines: string[] = [];
  for (let i = 0; i < raw2.length; i++) {
    const l = raw2[i]!;
    if (l === '-') {
      const next = raw2[i + 1];
      if (next !== undefined && next !== '-' && !next.startsWith('- ')) {
        lines.push(`- ${next}`);
        i += 1;
      }
      continue;
    }
    lines.push(l);
  }
  const out = lines.join('\n');
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** Clave de un prompt: minúsculas, sin espacios de más ni signos al final. */
export function seoAiPromptKey(prompt: string): string {
  return prompt
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.?!¿¡]+$/u, '')
    .replace(/^[\s¿¡]+/u, '')
    .trim()
    .slice(0, 500);
}

/** Clave de la marca de un proyecto: sus términos de marca juntos (misma consulta, misma clave). */
export function seoAiBrandSubject(brandTerms: readonly string[]): string | null {
  const terms = [...new Set(brandTerms.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();
  return terms.length ? terms.join(' | ').slice(0, 300) : null;
}

const prompt = z.string().trim().min(3).max(300);

export const UpdateSeoAiTrackedPromptsSchema = z.object({
  prompts: z
    .array(prompt)
    .max(SEO_AI_TRACKED_PROMPTS_MAX)
    .transform((list) => {
      const seen = new Set<string>();
      return list.filter((p) => {
        const k = seoAiPromptKey(p);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }),
});
export type UpdateSeoAiTrackedPromptsInput = z.infer<typeof UpdateSeoAiTrackedPromptsSchema>;

/** Ajustes guardados en `seo_projects.ai_visibility_settings`. */
export interface SeoAiVisibilitySettings {
  trackedPrompts: string[];
}

export function seoAiVisibilitySettingsOf(stored: unknown): SeoAiVisibilitySettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const list = Array.isArray(s.trackedPrompts)
    ? s.trackedPrompts.filter((p): p is string => typeof p === 'string' && p.trim().length >= 3)
    : [];
  return { trackedPrompts: list.slice(0, SEO_AI_TRACKED_PROMPTS_MAX) };
}

// ---------------------------------------------------------- la competencia

export interface SeoAiPromptRow {
  promptKey: string;
  prompt: string;
  model: string;
}

export interface SeoAiPromptGapDto {
  prompt: string;
  promptKey: string;
  /** Modelos en los que sale la competencia. */
  models: string[];
  /** Competidores que salen en ese prompt. */
  competitors: string[];
}

/**
 * Prompts en los que sale algún competidor y tú no (ni tu dominio ni tu
 * marca), ordenados por cuántos competidores salen. Oportunidad de contenido.
 */
export function seoAiPromptGaps(input: {
  own: readonly SeoAiPromptRow[];
  competitors: readonly { subject: string; prompts: readonly SeoAiPromptRow[] }[];
  limit?: number;
}): SeoAiPromptGapDto[] {
  const mine = new Set(input.own.map((p) => p.promptKey));
  const gaps = new Map<string, { prompt: string; models: Set<string>; competitors: Set<string> }>();
  for (const c of input.competitors) {
    for (const p of c.prompts) {
      if (!p.promptKey || mine.has(p.promptKey)) continue;
      const g = gaps.get(p.promptKey) ?? {
        prompt: p.prompt,
        models: new Set<string>(),
        competitors: new Set<string>(),
      };
      if (p.model) g.models.add(p.model);
      g.competitors.add(c.subject);
      gaps.set(p.promptKey, g);
    }
  }
  return [...gaps.entries()]
    .map(([promptKey, g]) => ({
      prompt: g.prompt,
      promptKey,
      models: [...g.models].sort(),
      competitors: [...g.competitors].sort(),
    }))
    .sort(
      (a, b) =>
        b.competitors.length - a.competitors.length ||
        b.models.length - a.models.length ||
        a.promptKey.localeCompare(b.promptKey),
    )
    .slice(0, input.limit ?? 50);
}

// ------------------------------------------------------------------ alerta

/**
 * «Desapareces de los buscadores de IA»: prompts en los que salías (tu
 * dominio o tu marca) en la consulta anterior y ya no en la última. Solo con
 * las dos consultas hechas; la clave es la del proyecto (una alerta viva).
 */
export function seoAiVisibilityLostAlert(input: {
  projectId: string;
  latestDate: string;
  previousDate: string;
  latest: readonly SeoAiPromptRow[];
  previous: readonly SeoAiPromptRow[];
  minLost: number;
}): SeoAlertCandidate | null {
  const now = new Set(input.latest.map((p) => p.promptKey));
  const lostMap = new Map<string, string>();
  for (const p of input.previous) {
    if (!now.has(p.promptKey) && !lostMap.has(p.promptKey)) lostMap.set(p.promptKey, p.prompt);
  }
  const lost = [...lostMap.values()];
  if (lost.length === 0 || lost.length < input.minLost) return null;
  const before = new Set(input.previous.map((p) => p.promptKey)).size;
  const fmt = (d: string) => d.split('-').reverse().join('/');
  return {
    type: 'ai_visibility_lost',
    key: `ai_visibility_lost|${input.projectId}`,
    severity: now.size === 0 ? 'high' : 'medium',
    title:
      lost.length === 1
        ? 'Has dejado de salir en un prompt de los buscadores de IA'
        : `Has dejado de salir en ${lost.length} prompts de los buscadores de IA`,
    message: `Consulta del ${fmt(input.latestDate)} frente a la del ${fmt(input.previousDate)}: salías en ${before} y ahora en ${now.size}. Según SISTRIX (estimación). Mira la pantalla «Visibilidad en IA».`,
    data: {
      latestDate: input.latestDate,
      previousDate: input.previousDate,
      lostCount: lost.length,
      // Texto de terceros (SISTRIX): se enseña como texto.
      lost: lost.slice(0, 10),
      before,
      now: now.size,
    },
  };
}

// --------------------------------------------------------------------- DTOs

export type SeoAiSubjectType = 'domain' | 'brand';

export interface SeoAiSubjectDto {
  subjectType: SeoAiSubjectType;
  subject: string;
  /** El proyecto (su dominio principal o su marca) frente a un competidor. */
  own: boolean;
  /** Prompts en los que sale en la última consulta (null = sin dato). */
  promptCount: number | null;
  previousCount: number | null;
  /** Evolución: una serie por fecha de consulta. */
  series: { date: string; promptCount: number }[];
  models: { model: string; promptCount: number }[];
  origin: SeoDataOriginDto | null;
}

export interface SeoAiPromptDto {
  prompt: string;
  promptKey: string;
  model: string;
  /** Respuesta de la IA: texto de terceros, recortado. */
  answer: string | null;
  /** Lo sigues (sus respuestas, con `ai_prompt_answers`). */
  tracked: boolean;
}

export interface SeoAiSourceDto {
  sourceType: 'domain' | 'url' | 'brand';
  source: string;
  count: number;
  /** Es tu web (un dominio del proyecto). */
  own: boolean;
}

export interface SeoAiTrackedPromptDto {
  prompt: string;
  promptKey: string;
  /** Última respuesta de cada modelo (texto de terceros). */
  answers: { model: string; answer: string | null; date: string }[];
  /** Sales tú (tu dominio o tu marca) en alguna de las respuestas. */
  mentionsYou: boolean;
}

export interface SeoAiVisibilityReportDto {
  country: string;
  /** Fecha de la última consulta de los datos propios. */
  latestDate: string | null;
  previousDate: string | null;
  subjects: SeoAiSubjectDto[];
  /** Prompts en los que sales (última consulta). */
  ownPrompts: SeoAiPromptDto[];
  /** Prompts en los que sale la competencia y tú no. */
  gaps: SeoAiPromptGapDto[];
  /** Fuentes que citan las IA (dominios y URL) y marcas que compiten. */
  sources: SeoAiSourceDto[];
  /** Tus páginas que citan las IA. */
  citedPages: SeoAiSourceDto[];
  competitorBrands: SeoAiSourceDto[];
  tracked: SeoAiTrackedPromptDto[];
  settings: SeoAiVisibilitySettings;
  /** Frecuencia de la consulta (la de SISTRIX del fondo) y la última tanda. */
  lastRunAt: string | null;
}
