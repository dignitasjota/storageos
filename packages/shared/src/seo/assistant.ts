import { z } from 'zod';

/**
 * SEO Avanzado, PR 11 (fase 5): asistente de SEO con herramientas de solo
 * lectura sobre los datos del proyecto, acciones que la persona confirma y
 * borradores de contenido (briefs) con propuestas de título y descripción.
 * Todo lo de este fichero es puro: el API reúne los datos y llama al modelo.
 */

/** `feature` del consumo de IA (`ai_usage_events`): se ve aparte en «Uso por tenant». */
export const SEO_ASSISTANT_FEATURE = 'seo_assistant';

// ----------------------------------------------------- contenido externo

/**
 * Delimitadores del texto que viene de fuera (títulos y URL de la competencia,
 * textos de páginas rastreadas, mensajes de Google): el prompt de sistema dice
 * que lo que va entre ellos es un dato y nunca una instrucción.
 */
export const SEO_UNTRUSTED_OPEN = '⟦externo⟧';
export const SEO_UNTRUSTED_CLOSE = '⟦/externo⟧';

/** Caracteres de control (salvo nada: también se quitan saltos y tabuladores). */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/**
 * Texto externo listo para ir al modelo: sin caracteres de control ni
 * invisibles, en una sola línea, sin los delimitadores (para que no se pueda
 * «cerrar» el bloque desde dentro), recortado y entre delimitadores.
 * Vacío → cadena vacía (no se marca lo que no hay).
 */
export function seoUntrusted(value: string | null | undefined, max = 300): string {
  if (value == null) return '';
  const clean = String(value)
    .replace(CONTROL_RE, ' ')
    .split(SEO_UNTRUSTED_OPEN)
    .join(' ')
    .split(SEO_UNTRUSTED_CLOSE)
    .join(' ')
    .replace(/[⟦⟧]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const cut = clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
  return `${SEO_UNTRUSTED_OPEN}${cut}${SEO_UNTRUSTED_CLOSE}`;
}

/** ¿Lleva un texto contenido externo delimitado? */
export function seoHasUntrusted(text: string): boolean {
  return text.includes(SEO_UNTRUSTED_OPEN);
}

// --------------------------------------------------------------- acciones

export const SEO_ASSISTANT_ACTION_TYPES = [
  'create_task',
  'register_change',
  'opportunity_in_progress',
  'follow_keyword',
] as const;
export type SeoAssistantActionType = (typeof SEO_ASSISTANT_ACTION_TYPES)[number];
export const SEO_ASSISTANT_ACTION_LABELS: Record<SeoAssistantActionType, string> = {
  create_task: 'Crear una tarea SEO',
  register_change: 'Registrar una actuación',
  opportunity_in_progress: 'Poner la oportunidad en curso',
  follow_keyword: 'Seguir una palabra',
};

export type SeoAssistantActionStatus =
  | 'proposed'
  | 'executing'
  | 'confirmed'
  | 'discarded'
  | 'failed'
  | 'expired';

export interface SeoAssistantActionDto {
  id: string;
  type: SeoAssistantActionType;
  summary: string;
  /** Lo que se guardará, para leerlo antes de confirmar. */
  details: string | null;
  status: SeoAssistantActionStatus;
  resultLink: string | null;
  resultError: string | null;
  createdAt: string;
}

// ----------------------------------------------------------- conversaciones

export const SeoAssistantChatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  content: z.string().trim().min(1, 'Escribe una pregunta').max(4000),
});
export type SeoAssistantChatInput = z.infer<typeof SeoAssistantChatSchema>;

export interface SeoAssistantMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed: string[];
  actions: SeoAssistantActionDto[];
  createdAt: string;
}

export interface SeoAssistantConversationDto {
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface SeoAssistantConversationDetailDto extends SeoAssistantConversationDto {
  messages: SeoAssistantMessageDto[];
}

export interface SeoAssistantChatResultDto {
  conversationId: string;
  message: SeoAssistantMessageDto;
}

/** Lo que se ve mientras el asistente consulta cada herramienta. */
export const SEO_ASSISTANT_TOOL_LABELS: Record<string, string> = {
  seo_summary: 'el resumen del periodo',
  seo_changes: 'búsquedas y páginas que cambian',
  seo_keyword: 'la ficha de una palabra',
  seo_opportunities: 'las oportunidades',
  seo_diagnostics: 'canibalización e indexación',
  seo_technical: 'inspecciones y velocidad',
  seo_crawl: 'el rastreo de la web',
  seo_competitors: 'la competencia',
  seo_serp: 'los resultados de Google',
  seo_conversions: 'lo que trae Google',
  seo_plan: 'actuaciones y tareas',
  seo_ga4_pages: 'las páginas de entrada en Google Analytics',
  seo_ai_visibility: 'la visibilidad en respuestas de IA',
  seo_propose_task: 'preparar una tarea',
  seo_propose_change: 'preparar una actuación',
  seo_propose_opportunity: 'preparar el cambio de una oportunidad',
  seo_propose_follow_keyword: 'preparar una palabra para seguir',
};

/** Preguntas para empezar. */
export const SEO_ASSISTANT_SUGGESTIONS = [
  '¿Qué páginas han caído este mes?',
  '¿Qué hago primero?',
  '¿Cómo vamos frente al periodo anterior?',
  '¿Qué búsquedas suben y cuáles bajan?',
  '¿Hay canibalización o páginas que no deberían estar en Google?',
  '¿Qué dice el último rastreo de la web?',
  '¿Qué tal van mis competidores?',
] as const;

// ------------------------------------------------------------------ briefs

export const SEO_BRIEF_SOURCES = ['keyword', 'opportunity', 'group', 'url', 'prompt'] as const;
export type SeoBriefSource = (typeof SEO_BRIEF_SOURCES)[number];
export const SEO_BRIEF_SOURCE_LABELS: Record<SeoBriefSource, string> = {
  keyword: 'Palabra seguida',
  opportunity: 'Oportunidad',
  group: 'Grupo de palabras',
  url: 'URL',
  prompt: 'Prompt de buscadores de IA',
};

export const SEO_BRIEF_STATUSES = ['draft', 'in_progress', 'published'] as const;
export type SeoBriefStatus = (typeof SEO_BRIEF_STATUSES)[number];
export const SeoBriefStatusEnum = z.enum(SEO_BRIEF_STATUSES);
export const SEO_BRIEF_STATUS_LABELS: Record<SeoBriefStatus, string> = {
  draft: 'Borrador',
  in_progress: 'En curso',
  published: 'Publicado',
};

export const CreateSeoBriefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('keyword'), keywordId: z.string().uuid() }),
  z.object({ source: z.literal('opportunity'), opportunityId: z.string().uuid() }),
  z.object({ source: z.literal('group'), groupName: z.string().trim().min(1).max(80) }),
  z.object({ source: z.literal('url'), url: z.string().trim().min(1).max(2000) }),
  // PR 12: un prompt de los buscadores de IA en el que sale la competencia y tú no.
  z.object({ source: z.literal('prompt'), prompt: z.string().trim().min(3).max(300) }),
]);
export type CreateSeoBriefInput = z.infer<typeof CreateSeoBriefSchema>;

export const UpdateSeoBriefSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    status: SeoBriefStatusEnum,
    contentMarkdown: z.string().max(60_000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nada que cambiar');
export type UpdateSeoBriefInput = z.infer<typeof UpdateSeoBriefSchema>;

export const SeoBriefToDraftSchema = z
  .object({
    blog: z.boolean().default(false),
    task: z.boolean().default(false),
  })
  .refine((v) => v.blog || v.task, 'Elige el blog, la tarea o las dos cosas');
export type SeoBriefToDraftInput = z.infer<typeof SeoBriefToDraftSchema>;

/** Longitudes recomendadas (en caracteres) de lo que enseña Google. */
export const SEO_META_TITLE_RANGE = { min: 30, max: 60 } as const;
export const SEO_META_DESCRIPTION_RANGE = { min: 70, max: 160 } as const;

export type SeoMetaLengthStatus = 'short' | 'ok' | 'long';

export function seoMetaLengthStatus(
  text: string,
  range: { min: number; max: number },
): SeoMetaLengthStatus {
  const n = [...text].length;
  if (n < range.min) return 'short';
  if (n > range.max) return 'long';
  return 'ok';
}

export interface SeoMetaProposalDto {
  title: string;
  titleLength: number;
  titleStatus: SeoMetaLengthStatus;
  description: string;
  descriptionLength: number;
  descriptionStatus: SeoMetaLengthStatus;
}

/** Una propuesta de título y descripción con sus longitudes calculadas aquí (no por el modelo). */
export function seoMetaProposal(title: string, description: string): SeoMetaProposalDto {
  const t = title.replace(/\s+/g, ' ').trim();
  const d = description.replace(/\s+/g, ' ').trim();
  return {
    title: t,
    titleLength: [...t].length,
    titleStatus: seoMetaLengthStatus(t, SEO_META_TITLE_RANGE),
    description: d,
    descriptionLength: [...d].length,
    descriptionStatus: seoMetaLengthStatus(d, SEO_META_DESCRIPTION_RANGE),
  };
}

export interface SeoBriefKeywordDto {
  keyword: string;
  clicks: number | null;
  impressions: number | null;
  position: number | null;
  /** gsc: Search Console (90 días) · sistrix: ideas y preguntas ya descargadas · tracked: palabras seguidas */
  source: 'gsc' | 'sistrix' | 'tracked';
}

export interface SeoBriefLinkDto {
  url: string;
  reason: string;
}

export interface SeoBriefSerpDto {
  position: number;
  domain: string;
  url: string;
}

/** Estructura de un brief (lo que se guarda en `structure`). */
export interface SeoBriefStructure {
  version: 1;
  intent: string;
  objective: string;
  targetUrl: string | null;
  /** Si no hay página: la URL que se propone crear. */
  proposedUrl: string | null;
  h1: string;
  outline: { level: 2 | 3; text: string }[];
  keywords: SeoBriefKeywordDto[];
  questions: string[];
  faqs: { question: string; answer: string }[];
  internalLinks: { from: SeoBriefLinkDto[]; to: SeoBriefLinkDto[]; note: string | null };
  serp: SeoBriefSerpDto[];
  serpDate: string | null;
  metaProposals: SeoMetaProposalDto[];
  /** Datos públicos del negocio (locales, horarios, tamaños y precios): a verificar. */
  business: string[];
  /** Lo que falta o hay que tener en cuenta (sin SISTRIX, sin rastreo…). */
  dataNotes: string[];
  /** Lo que el modelo marca para verificar. */
  verify: string[];
  generatedAt: string;
}

export interface SeoBriefDto {
  id: string;
  projectId: string;
  source: SeoBriefSource;
  sourceId: string | null;
  sourceLabel: string;
  title: string;
  keywords: string[];
  targetUrl: string | null;
  status: SeoBriefStatus;
  structure: SeoBriefStructure;
  contentMarkdown: string;
  taskId: string | null;
  changeId: string | null;
  blogPostId: string | null;
  platformBlogPostId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SeoBriefListItemDto = Omit<SeoBriefDto, 'structure' | 'contentMarkdown'>;

export interface SeoBriefToDraftResultDto {
  brief: SeoBriefDto;
  /** Dónde editar la entrada creada en el blog (en borrador). */
  blogLink: string | null;
  taskId: string | null;
}

// --------------------------------------------------- respuesta del modelo

const AiBriefReplySchema = z.object({
  intent: z.string().trim().min(1).max(600),
  objective: z.string().trim().min(1).max(600),
  h1: z.string().trim().min(1).max(200),
  proposedUrl: z.string().trim().max(300).nullable().optional(),
  outline: z
    .array(
      z.object({
        level: z.union([z.literal(2), z.literal(3)]),
        text: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(30),
  questions: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  faqs: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(300),
        answer: z.string().trim().max(1200),
      }),
    )
    .max(12)
    .optional(),
  metaProposals: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(400),
      }),
    )
    .min(1)
    .max(6),
  verify: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
});
export type SeoBriefAiReply = z.infer<typeof AiBriefReplySchema>;

/**
 * Lee la respuesta del modelo (un JSON, a veces envuelto en ```json). null si
 * no sirve. Se quedan las 3 primeras propuestas de título y descripción.
 */
export function parseSeoBriefReply(text: string): SeoBriefAiReply | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = AiBriefReplySchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, metaProposals: parsed.data.metaProposals.slice(0, 3) };
}

// ----------------------------------------------------------------- Markdown

const fmtInt = (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('es-ES'));
const fmtPos = (n: number | null) => (n == null ? '—' : n.toFixed(1).replace('.', ','));

/** Aviso que encabeza todo lo generado con IA. */
export const SEO_AI_DRAFT_NOTICE =
  'Generado con IA: revísalo antes de usarlo. Comprueba precios, horarios y cualquier dato del negocio, y no lo publiques sin leerlo.';

/** El brief entero en Markdown (para editar, copiar y exportar). */
export function seoBriefMarkdown(
  s: SeoBriefStructure,
  meta: { title: string; sourceLabel: string; source: SeoBriefSource },
): string {
  const out: string[] = [];
  out.push(`# ${meta.title}`, '', `> ${SEO_AI_DRAFT_NOTICE}`, '');
  out.push(`**Origen:** ${SEO_BRIEF_SOURCE_LABELS[meta.source]} · ${meta.sourceLabel}`, '');
  out.push(
    '## Intención y objetivo',
    '',
    `- **Intención:** ${s.intent}`,
    `- **Objetivo:** ${s.objective}`,
  );
  if (s.targetUrl) out.push(`- **URL objetivo:** ${s.targetUrl}`);
  else if (s.proposedUrl) out.push(`- **URL nueva propuesta:** ${s.proposedUrl}`);
  out.push('');
  if (s.keywords.length > 0) {
    out.push(
      '## Búsquedas a cubrir',
      '',
      '| Búsqueda | Clics | Impresiones | Posición | Origen |',
      '| --- | ---: | ---: | ---: | --- |',
    );
    for (const k of s.keywords) {
      const origin =
        k.source === 'gsc'
          ? 'Search Console'
          : k.source === 'sistrix'
            ? 'SISTRIX'
            : 'Palabra seguida';
      out.push(
        `| ${k.keyword} | ${fmtInt(k.clicks)} | ${fmtInt(k.impressions)} | ${fmtPos(k.position)} | ${origin} |`,
      );
    }
    out.push('');
  }
  out.push('## Estructura propuesta', '', `**H1:** ${s.h1}`, '');
  for (const h of s.outline)
    out.push(`${h.level === 2 ? '- ' : '  - '}${h.level === 2 ? 'H2' : 'H3'}: ${h.text}`);
  out.push('');
  if (s.questions.length > 0) {
    out.push('## Preguntas que hace la gente', '');
    for (const q of s.questions) out.push(`- ${q}`);
    out.push('');
  }
  if (s.faqs.length > 0) {
    out.push('## Preguntas frecuentes', '');
    for (const f of s.faqs) out.push(`**${f.question}**`, '', f.answer || '_(Por responder)_', '');
  }
  out.push('## Enlaces internos', '');
  if (s.internalLinks.from.length === 0 && s.internalLinks.to.length === 0) {
    out.push(s.internalLinks.note ?? 'Sin datos del rastreo.', '');
  } else {
    if (s.internalLinks.from.length > 0) {
      out.push('Enlazar desde:', '');
      for (const l of s.internalLinks.from) out.push(`- ${l.url} — ${l.reason}`);
      out.push('');
    }
    if (s.internalLinks.to.length > 0) {
      out.push('Enlazar hacia:', '');
      for (const l of s.internalLinks.to) out.push(`- ${l.url} — ${l.reason}`);
      out.push('');
    }
    if (s.internalLinks.note) out.push(s.internalLinks.note, '');
  }
  out.push('## Primeros resultados de Google', '');
  if (s.serp.length === 0) out.push('Sin resultados guardados de esta búsqueda.', '');
  else {
    out.push(
      `Según SISTRIX${s.serpDate ? ` (${s.serpDate})` : ''}. Solo dominio y URL: no se ha descargado su contenido.`,
      '',
    );
    for (const r of s.serp) out.push(`${r.position}. ${r.domain} — ${r.url}`);
    out.push('');
  }
  out.push('## Propuestas de título y descripción', '');
  s.metaProposals.forEach((m, i) => {
    out.push(
      `${i + 1}. **${m.title}** (${m.titleLength} caracteres${m.titleStatus === 'ok' ? '' : m.titleStatus === 'short' ? ', corto' : ', largo'})`,
      `   ${m.description} (${m.descriptionLength} caracteres${m.descriptionStatus === 'ok' ? '' : m.descriptionStatus === 'short' ? ', corta' : ', larga'})`,
    );
  });
  out.push('');
  if (s.business.length > 0) {
    out.push('## Datos del negocio (a verificar)', '');
    for (const l of s.business) out.push(l.startsWith('-') || l.startsWith(' ') ? l : `- ${l}`);
    out.push('');
  }
  if (s.verify.length > 0 || s.dataNotes.length > 0) {
    out.push('## A tener en cuenta', '');
    for (const v of s.verify) out.push(`- Verificar: ${v}`);
    for (const n of s.dataNotes) out.push(`- ${n}`);
    out.push('');
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

/**
 * Texto de la entrada del blog en borrador a partir del brief: el aviso de IA,
 * la estructura con un hueco por sección y las preguntas frecuentes. Nunca se
 * publica sola.
 */
export function seoBriefBlogDraft(s: SeoBriefStructure): string {
  const out: string[] = [`> ${SEO_AI_DRAFT_NOTICE}`, ''];
  for (const h of s.outline) {
    out.push(`${h.level === 2 ? '##' : '###'} ${h.text}`, '', '_(Escribe aquí esta sección.)_', '');
  }
  if (s.faqs.length > 0) {
    out.push('## Preguntas frecuentes', '');
    for (const f of s.faqs) out.push(`### ${f.question}`, '', f.answer || '_(Por responder)_', '');
  }
  return out.join('\n').trim() + '\n';
}
