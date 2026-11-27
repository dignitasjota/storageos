import { createHash } from 'node:crypto';

import { seoAiAnswerText } from '@storageos/shared';

/**
 * Consultas a SISTRIX y normalización de sus respuestas. Lo mismo vale para el
 * MCP y para la API clásica: cada consulta (`SistrixQuery`) se traduce a una
 * herramienta y vista del MCP o a un método de la API, y la respuesta pasa por
 * el mismo normalizador.
 *
 * Peculiaridades comprobadas con el servidor real (fixtures en `__tests__`):
 * - Unas herramientas devuelven `structuredContent` y otras solo texto con JSON.
 * - Los errores llegan como texto con `isError: false`:
 *   `SISTRIX API Error (<código>): <mensaje>`. El 1000 («no result») es una
 *   respuesta vacía, no un error; el 7010 es la cuota diaria agotada.
 * - Los números llegan a veces como texto (`"value": "0"`).
 * - Nombres de campo en alemán (`sichtbarkeitsindex`).
 */

export type SistrixOp =
  | 'visindex'
  | 'kwcount'
  | 'competitors'
  | 'opportunities'
  | 'ideas'
  | 'serp'
  | 'domain_keywords'
  | 'metrics'
  | 'searchintent'
  | 'linktargets'
  | 'ai_overview'
  // PR 12: el resto de `ai_check` y las respuestas de un prompt.
  | 'ai_prompts'
  | 'ai_sources'
  | 'ai_competitors'
  | 'ai_answers';

export interface SistrixQuery {
  op: SistrixOp;
  country: string;
  domain?: string;
  keyword?: string;
  limit?: number;
  history?: boolean;
  /** `ai_check`: marcas (además de, o en vez de, un dominio). */
  brands?: string[];
  /** `ai_check` con la vista `sources`: por dominio o por URL. */
  sourceType?: 'domain' | 'url';
  /** `ai_prompt_answers`: el prompt. */
  prompt?: string;
}

/** Huella de una consulta: la misma para el MCP y la API (la caché se comparte). */
export function sistrixQueryHash(q: SistrixQuery): string {
  const canonical = JSON.stringify({
    op: q.op,
    country: q.country.toLowerCase(),
    domain: q.domain ?? null,
    keyword: q.keyword ?? null,
    limit: q.limit ?? null,
    history: q.history ?? false,
    // Solo si están: las huellas de las consultas anteriores no cambian.
    ...(q.brands?.length ? { brands: [...q.brands].map((b) => b.toLowerCase()).sort() } : {}),
    ...(q.sourceType ? { sourceType: q.sourceType } : {}),
    ...(q.prompt ? { prompt: q.prompt.trim().toLowerCase() } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ------------------------------------------------------------- traducción

/** Herramientas y vistas del MCP que usamos (para avisar si desaparecen). */
export const SISTRIX_MCP_USED: Record<string, string[] | null> = {
  domain: ['visindex', 'kwcount', 'competitors', 'opportunities', 'ideas'],
  keyword: ['seo', 'metrics', 'searchintent'],
  keyword_domain_seo: null,
  links: ['linktargets'],
  ai_check: ['overview', 'competitors', 'prompts', 'sources'],
  ai_prompt_answers: null,
};

/**
 * Nunca se llaman: los de Optimizer y AI Tracker necesitan proyectos de
 * SISTRIX, y `ai_topicresearch` con la vista `list` gasta créditos.
 */
export function sistrixCallForbidden(tool: string, view?: string | null): boolean {
  if (tool.startsWith('project') || tool.startsWith('ai_tracker')) return true;
  if (tool === 'ai_topicresearch' && view === 'list') return true;
  return false;
}

export interface McpCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Vistas de `ai_check` de cada operación. */
const AI_CHECK_VIEWS = {
  ai_overview: 'overview',
  ai_prompts: 'prompts',
  ai_sources: 'sources',
  ai_competitors: 'competitors',
} as const;

/** Herramienta y argumentos del MCP. El país siempre explícito (el suyo por defecto es `de`). */
export function toMcpCall(q: SistrixQuery): McpCall {
  const country = q.country.toLowerCase();
  const limit = q.limit ?? undefined;
  const withLimit = (args: Record<string, unknown>) =>
    limit !== undefined ? { ...args, limit } : args;
  switch (q.op) {
    case 'visindex':
      return {
        tool: 'domain',
        args: withLimit({
          domain: q.domain,
          view: 'visindex',
          country,
          ...(q.history ? { history: true } : {}),
        }),
      };
    case 'kwcount':
      return { tool: 'domain', args: { domain: q.domain, view: 'kwcount', country } };
    case 'competitors':
    case 'opportunities':
    case 'ideas':
      return { tool: 'domain', args: withLimit({ domain: q.domain, view: q.op, country }) };
    case 'serp':
      return { tool: 'keyword', args: withLimit({ view: 'seo', keyword: q.keyword, country }) };
    case 'metrics':
    case 'searchintent':
      return { tool: 'keyword', args: { view: q.op, keyword: q.keyword, country } };
    case 'domain_keywords':
      return { tool: 'keyword_domain_seo', args: withLimit({ domain: q.domain, country }) };
    case 'linktargets':
      return { tool: 'links', args: withLimit({ domain: q.domain, view: 'linktargets' }) };
    case 'ai_overview':
    case 'ai_prompts':
    case 'ai_sources':
    case 'ai_competitors': {
      const view = AI_CHECK_VIEWS[q.op];
      return {
        tool: 'ai_check',
        args: {
          view,
          ...(q.domain ? { domains: q.domain } : {}),
          ...(q.brands?.length ? { brands: q.brands } : {}),
          country,
          ...(q.op === 'ai_sources' ? { source_type: q.sourceType ?? 'url' } : {}),
          ...(q.op !== 'ai_overview' && limit !== undefined ? { limit } : {}),
        },
      };
    }
    case 'ai_answers':
      return {
        tool: 'ai_prompt_answers',
        args: { prompt: q.prompt ?? '', country, ...(limit !== undefined ? { limit } : {}) },
      };
  }
}

export interface ApiCall {
  method: string;
  params: Record<string, string>;
}

/**
 * Método y parámetros de la API clásica (`https://api.sistrix.com/<método>`).
 * `null` = no hay equivalente por la API (se espera al MCP).
 */
export function toApiCall(q: SistrixQuery): ApiCall | null {
  const country = q.country.toLowerCase();
  const num = q.limit !== undefined ? { num: String(q.limit) } : {};
  const domain = q.domain ?? '';
  const kw = q.keyword ?? '';
  switch (q.op) {
    case 'visindex':
      return {
        method: 'domain.visibilityindex',
        params: { domain, country, ...(q.history ? { history: 'true' } : {}), ...num },
      };
    case 'kwcount':
      return { method: 'domain.kwcount.seo', params: { domain, country } };
    case 'competitors':
      return { method: 'domain.competitors.seo', params: { domain, country, ...num } };
    case 'opportunities':
      return { method: 'domain.opportunities', params: { domain, country, ...num } };
    case 'ideas':
      return { method: 'domain.ideas', params: { domain, country, ...num } };
    case 'serp':
      return { method: 'keyword.seo', params: { kw, country, ...num } };
    case 'metrics':
      return { method: 'keyword.seo.metrics', params: { kw, country } };
    case 'searchintent':
      return { method: 'keyword.seo.searchintent', params: { kw, country } };
    case 'domain_keywords':
      return { method: 'keyword.domain.seo', params: { domain, country, ...num } };
    case 'linktargets':
      return { method: 'links.linktargets', params: { domain, ...num } };
    case 'ai_overview':
    case 'ai_prompts':
    case 'ai_sources':
    case 'ai_competitors':
    case 'ai_answers':
      // Visibilidad en IA: solo por el MCP.
      return null;
  }
}

/**
 * Lo que cuesta como mucho una llamada a la API clásica: un crédito por dato
 * devuelto (las `num` filas que se piden; con `history`, también `num` semanas)
 * y cinco por palabra en las métricas. Sirve para negar la consulta antes si no
 * cabe en el presupuesto que queda, y como coste asumido si la respuesta no
 * dice cuánto gastó.
 */
export function estimateApiCallCredits(method: string, params: Record<string, string>): number {
  if (method === 'keyword.seo.metrics') return 5;
  const rows = Number(params.num);
  return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 1;
}

/** Lo mismo, sobre la consulta (null si no existe en la API clásica). */
export function estimateApiCredits(q: SistrixQuery): number | null {
  const call = toApiCall(q);
  return call ? estimateApiCallCredits(call.method, call.params) : null;
}

// ------------------------------------------------------------ respuestas

/** Resultado de `tools/call` tal como lo da el SDK. */
export interface McpToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type SistrixPayload =
  | { kind: 'payload'; value: unknown }
  | { kind: 'empty' }
  | { kind: 'quota'; message: string }
  | { kind: 'error'; code: string | null; message: string };

const ERROR_RE = /^\s*SISTRIX API Error \((\d+)\):\s*([\s\S]*)$/;
/** Sin resultados: una respuesta vacía, no un fallo. */
export const SISTRIX_NO_RESULT = '1000';
/** Cuota diaria agotada: se para hasta el día siguiente. */
export const SISTRIX_QUOTA_EXHAUSTED = '7010';

export function classifySistrixError(code: string | null, message: string): SistrixPayload {
  if (code === SISTRIX_NO_RESULT) return { kind: 'empty' };
  if (code === SISTRIX_QUOTA_EXHAUSTED) return { kind: 'quota', message };
  return { kind: 'error', code, message };
}

/** Saca el contenido de un resultado del MCP (estructurado o texto con JSON) o su error. */
export function parseMcpResult(result: McpToolResult): SistrixPayload {
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
  const err = ERROR_RE.exec(text);
  if (err) return classifySistrixError(err[1] ?? null, (err[2] ?? '').trim());
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return { kind: 'payload', value: result.structuredContent };
  }
  if (!text) {
    return result.isError
      ? { kind: 'error', code: null, message: 'SISTRIX devolvió un error sin texto' }
      : { kind: 'empty' };
  }
  try {
    return { kind: 'payload', value: JSON.parse(text) as unknown };
  } catch {
    return {
      kind: 'error',
      code: null,
      message: result.isError
        ? text.slice(0, 300)
        : `Respuesta que no se entiende: ${text.slice(0, 200)}`,
    };
  }
}

// --------------------------------------------------------- normalizadores

/** Número de un valor que puede venir como texto (`"0"`, `"12,5"`). */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const int = (value: unknown): number | null => {
  const n = num(value);
  return n === null ? null : Math.round(n);
};
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Primer array de la respuesta (las vistas lo envuelven en una clave u otra). */
function firstArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObj(value)) return [];
  for (const k of keys) if (Array.isArray(value[k])) return value[k] as unknown[];
  for (const v of Object.values(value)) if (Array.isArray(v)) return v;
  return [];
}

export interface DatedPoint {
  domain: string | null;
  date: string;
  value: number;
}

/** Visibilidad (`sichtbarkeitsindex`) o recuentos con fecha. */
export function normalizeDatedPoints(value: unknown): DatedPoint[] {
  const rows = firstArray(value, [
    'sichtbarkeitsindex',
    'visibilityindex',
    'visindex',
    'kwcount',
    'kwcount_top10',
    'value',
  ]);
  const out: DatedPoint[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const date = str(r.date);
    const v = num(r.value ?? r.sichtbarkeitsindex ?? r.count);
    if (!date || v === null) continue;
    out.push({ domain: str(r.domain), date: date.slice(0, 10), value: v });
  }
  return out;
}

/** Competidores orgánicos: solo nombres de dominio. */
export function normalizeCompetitors(value: unknown): string[] {
  const rows = firstArray(value, ['competitors', 'domains', 'result']);
  const out: string[] = [];
  for (const r of rows) {
    const d = typeof r === 'string' ? r : isObj(r) ? str(r.domain) : null;
    if (d) out.push(d.toLowerCase());
  }
  return [...new Set(out)];
}

export interface KeywordRow {
  keyword: string;
  position: number | null;
  url: string | null;
  gain: number | null;
  competition: number | null;
  traffic: number | null;
}

/** Oportunidades, ideas y palabras de un dominio. */
export function normalizeKeywordRows(value: unknown): KeywordRow[] {
  const rows = firstArray(value, ['result', 'keywords', 'opportunities', 'ideas']);
  const out: KeywordRow[] = [];
  for (const r of rows) {
    if (typeof r === 'string') {
      out.push({
        keyword: r,
        position: null,
        url: null,
        gain: null,
        competition: null,
        traffic: null,
      });
      continue;
    }
    if (!isObj(r)) continue;
    const keyword = str(r.keyword ?? r.kw);
    if (!keyword) continue;
    out.push({
      keyword,
      position: int(r.position ?? r.pos),
      url: str(r.url),
      gain: int(r.gain),
      competition: int(r.competition),
      traffic: int(r.traffic),
    });
  }
  return out;
}

export interface SerpRow {
  position: number;
  domain: string;
  url: string;
}

/** Resultados de Google de una palabra. */
export function normalizeSerp(value: unknown): SerpRow[] {
  const out: SerpRow[] = [];
  for (const r of firstArray(value, ['result', 'serp'])) {
    if (!isObj(r)) continue;
    const position = int(r.position ?? r.pos);
    const domain = str(r.domain);
    if (position === null || !domain) continue;
    out.push({ position, domain: domain.toLowerCase(), url: str(r.url) ?? '' });
  }
  return out.sort((a, b) => a.position - b.position);
}

export interface KeywordMetrics {
  traffic: number | null;
  clicks: number | null;
  cpc: number | null;
  competition: number | null;
  mobileShare: number | null;
  desktopShare: number | null;
}

export function normalizeMetrics(value: unknown): KeywordMetrics | null {
  const r = firstArray(value, ['result'])[0] ?? (isObj(value) ? value : null);
  if (!isObj(r)) return null;
  return {
    traffic: int(r.traffic),
    clicks: int(r.clicks),
    cpc: num(r.cpc),
    competition: int(r.competition),
    mobileShare: num(r.mobile_distribution),
    desktopShare: num(r.desktop_distribution),
  };
}

export interface KeywordIntent {
  know: number | null;
  do: number | null;
  visit: number | null;
  website: number | null;
}

export function normalizeIntent(value: unknown): KeywordIntent | null {
  const r = firstArray(value, ['result'])[0] ?? (isObj(value) ? value : null);
  if (!isObj(r)) return null;
  return {
    know: int(r.intent_know),
    do: int(r.intent_do),
    visit: int(r.intent_visit),
    website: int(r.intent_website),
  };
}

export interface LinkTarget {
  url: string;
  links: number;
  domains: number;
  hosts: number;
}

export function normalizeLinkTargets(value: unknown): LinkTarget[] {
  const out: LinkTarget[] = [];
  for (const r of firstArray(value, ['result', 'linktargets'])) {
    if (!isObj(r)) continue;
    const url = str(r.url);
    if (!url) continue;
    out.push({
      url,
      links: int(r.links) ?? 0,
      domains: int(r.domains) ?? 0,
      hosts: int(r.hosts) ?? 0,
    });
  }
  return out;
}

export interface AiOverview {
  promptCount: number;
  models: { model: string; promptCount: number }[];
}

export function normalizeAiOverview(value: unknown): AiOverview | null {
  if (!isObj(value)) return null;
  const counts = firstArray(value.counts, []);
  const first = counts[0];
  const promptCount = isObj(first) ? (int(first.prompt_count) ?? 0) : 0;
  const models: AiOverview['models'] = [];
  for (const group of firstArray(value.models, [])) {
    for (const m of isObj(group) ? firstArray(group.model, []) : []) {
      if (!isObj(m)) continue;
      const model = str(m.model);
      if (model) models.push({ model, promptCount: int(m.prompt_count) ?? 0 });
    }
  }
  return { promptCount, models };
}

/**
 * Aplana las vistas de `ai_check`: unas filas vienen sueltas y otras
 * envueltas en un grupo (`{ prompts: [{ prompt: [ … ] }] }`, como `models` del
 * resumen). Devuelve los objetos hoja.
 */
function aiRows(value: unknown, keys: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (rows: unknown[], depth: number) => {
    for (const r of rows) {
      if (!isObj(r)) continue;
      const nested = keys
        .map((k) => r[k])
        .find((v): v is unknown[] => Array.isArray(v) && v.some((x) => isObj(x)));
      if (nested && depth < 3) visit(nested, depth + 1);
      else out.push(r);
    }
  };
  visit(firstArray(value, keys), 0);
  return out;
}

export interface AiPromptRow {
  prompt: string;
  model: string;
  /** Respuesta de la IA: texto de terceros (se guarda, nunca se interpreta). */
  answer: string | null;
  rank: number | null;
}

/**
 * Vista `prompts` de `ai_check` y respuestas de `ai_prompt_answers`.
 * `ai_prompt_answers` (comprobado con el servidor real) no repite el prompt en
 * cada fila (`{ answers: [{ answer, model, country }] }`): con `answers`, la fila
 * sin prompt se acepta y el prompt lo pone quien hizo la consulta.
 */
export function normalizeAiPrompts(
  value: unknown,
  opts: { answers?: boolean } = {},
): AiPromptRow[] {
  const rows = aiRows(value, ['prompts', 'prompt', 'answers', 'answer', 'result', 'data']);
  const out: AiPromptRow[] = [];
  for (const r of rows) {
    const prompt =
      str(r.prompt) ??
      str(r.query) ??
      str(r.keyword) ??
      str(r.question) ??
      (opts.answers ? '' : null);
    if (prompt === null) continue;
    const model = (str(r.model) ?? str(r.llm) ?? str(r.engine) ?? '').toLowerCase();
    // La vista `prompts` la da en HTML en `message` (comprobado con el servidor
    // real): se guarda como texto plano limpio, nunca el HTML.
    const raw = str(r.message) ?? str(r.answer) ?? str(r.response) ?? str(r.text) ?? str(r.content);
    const answer = raw ? seoAiAnswerText(raw) || null : null;
    out.push({
      prompt: prompt.slice(0, 500),
      model: model === 'aimode' ? 'ai_mode' : model,
      answer,
      rank: int(r.rank ?? r.position),
    });
  }
  return out;
}

export interface AiSourceRow {
  source: string;
  count: number;
}

/**
 * Vista `sources` (dominio o URL citados: `{ competitor: [{ source, amount,
 * prompt_count }] }`) o `competitors` (marcas que compiten: `{ competitor:
 * [{ brand }] }`, sin dominio ni recuento: queda a 0).
 */
export function normalizeAiSources(value: unknown, field: 'source' | 'brand'): AiSourceRow[] {
  const keys =
    field === 'brand'
      ? ['competitors', 'competitor', 'brands', 'brand', 'result', 'data']
      : [
          // `{ competitor: [{ source, amount, prompt_count }] }` (servidor real).
          'competitor',
          'sources',
          'source',
          'urls',
          'url',
          'domains',
          'domain',
          'hosts',
          'host',
          'result',
          'data',
        ];
  const rows = aiRows(value, keys);
  const out: AiSourceRow[] = [];
  for (const r of rows) {
    const name =
      field === 'brand'
        ? (str(r.brand) ?? str(r.competitor) ?? str(r.name) ?? str(r.domain))
        : (str(r.url) ?? str(r.source) ?? str(r.domain) ?? str(r.host));
    if (!name) continue;
    out.push({
      source: name.slice(0, 1000),
      // `amount` = veces citada (real); si no, el recuento que traiga.
      count:
        int(r.amount ?? r.count ?? r.citations ?? r.mentions ?? r.prompt_count ?? r.value) ?? 0,
    });
  }
  return out;
}

/** Lo que se guarda de cada consulta (y en la caché). */
export type SistrixData =
  | { op: 'visindex' | 'kwcount'; points: DatedPoint[] }
  | { op: 'competitors'; domains: string[] }
  | { op: 'opportunities' | 'ideas' | 'domain_keywords'; rows: KeywordRow[] }
  | { op: 'serp'; rows: SerpRow[] }
  | { op: 'metrics'; metrics: KeywordMetrics | null }
  | { op: 'searchintent'; intent: KeywordIntent | null }
  | { op: 'linktargets'; rows: LinkTarget[] }
  | { op: 'ai_overview'; overview: AiOverview | null }
  | { op: 'ai_prompts' | 'ai_answers'; prompts: AiPromptRow[] }
  | { op: 'ai_sources' | 'ai_competitors'; sources: AiSourceRow[] };

export type SistrixOutcome =
  | { kind: 'ok'; data: SistrixData; dataDate: string | null }
  | { kind: 'empty' }
  | { kind: 'quota'; message: string }
  | { kind: 'error'; code: string | null; message: string };

/** ¿La respuesta trae algo (una lista con elementos, un número, un texto)? */
function hasContent(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (Array.isArray(value)) return value.some((v) => hasContent(v, depth + 1));
  if (isObj(value)) return Object.values(value).some((v) => hasContent(v, depth + 1));
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return false;
}

/**
 * Normaliza el contenido de una consulta según la operación. «SISTRIX dijo que
 * no hay resultado» (1000) es `empty`; una respuesta con contenido que no
 * entendemos es un error (`unknown_shape`): no se cachea días como si no
 * hubiera datos y avisa de que SISTRIX cambió algo.
 */
export function normalizeSistrix(op: SistrixOp, payload: SistrixPayload): SistrixOutcome {
  const out = normalizeSistrixPayload(op, payload);
  if (out.kind === 'error' && /\b7010\b/.test(out.message)) {
    return { kind: 'quota', message: out.message };
  }
  if (out.kind === 'empty' && payload.kind === 'payload' && hasContent(payload.value)) {
    return {
      kind: 'error',
      code: 'unknown_shape',
      message: `SISTRIX devolvió datos de «${op}» con una forma que no entendemos. Puede que haya cambiado su formato.`,
    };
  }
  return out;
}

function normalizeSistrixPayload(op: SistrixOp, payload: SistrixPayload): SistrixOutcome {
  if (payload.kind !== 'payload') return payload;
  const value = payload.value;
  switch (op) {
    case 'visindex':
    case 'kwcount': {
      const points = normalizeDatedPoints(value);
      if (points.length === 0) return { kind: 'empty' };
      const dataDate =
        points
          .map((p) => p.date)
          .sort()
          .at(-1) ?? null;
      return { kind: 'ok', data: { op, points }, dataDate };
    }
    case 'competitors': {
      const domains = normalizeCompetitors(value);
      return domains.length
        ? { kind: 'ok', data: { op, domains }, dataDate: null }
        : { kind: 'empty' };
    }
    case 'opportunities':
    case 'ideas':
    case 'domain_keywords': {
      const rows = normalizeKeywordRows(value);
      return rows.length ? { kind: 'ok', data: { op, rows }, dataDate: null } : { kind: 'empty' };
    }
    case 'serp': {
      const rows = normalizeSerp(value);
      return rows.length ? { kind: 'ok', data: { op, rows }, dataDate: null } : { kind: 'empty' };
    }
    case 'metrics': {
      const metrics = normalizeMetrics(value);
      return metrics ? { kind: 'ok', data: { op, metrics }, dataDate: null } : { kind: 'empty' };
    }
    case 'searchintent': {
      const intent = normalizeIntent(value);
      return intent ? { kind: 'ok', data: { op, intent }, dataDate: null } : { kind: 'empty' };
    }
    case 'linktargets': {
      const rows = normalizeLinkTargets(value);
      return rows.length ? { kind: 'ok', data: { op, rows }, dataDate: null } : { kind: 'empty' };
    }
    case 'ai_overview': {
      const overview = normalizeAiOverview(value);
      return overview ? { kind: 'ok', data: { op, overview }, dataDate: null } : { kind: 'empty' };
    }
    case 'ai_prompts':
    case 'ai_answers': {
      const prompts = normalizeAiPrompts(value, { answers: op === 'ai_answers' });
      return prompts.length
        ? { kind: 'ok', data: { op, prompts }, dataDate: null }
        : { kind: 'empty' };
    }
    case 'ai_sources':
    case 'ai_competitors': {
      const sources = normalizeAiSources(value, op === 'ai_competitors' ? 'brand' : 'source');
      return sources.length
        ? { kind: 'ok', data: { op, sources }, dataDate: null }
        : { kind: 'empty' };
    }
  }
}

/**
 * Respuesta de la API clásica: `{ answer: [...], credits: [{ used }] }` o
 * `{ error: [{ code, error_message }] }`. Se normaliza igual que la del MCP.
 */
export function parseApiResponse(body: unknown): {
  payload: SistrixPayload;
  credits: number;
  /** La respuesta decía cuánto gastó (si no, el coste es una suposición). */
  creditsKnown: boolean;
} {
  if (!isObj(body)) {
    return {
      payload: { kind: 'error', code: null, message: 'Respuesta vacía de la API' },
      credits: 0,
      creditsKnown: false,
    };
  }
  const creditsRow = firstArray(body.credits, [])[0];
  const usedCredits = isObj(creditsRow) ? int(creditsRow.used) : null;
  const credits = usedCredits ?? 0;
  const creditsKnown = usedCredits !== null;
  const errorRow = firstArray(body.error, [])[0];
  if (isObj(errorRow)) {
    const code =
      str(errorRow.code) ?? (int(errorRow.code) !== null ? String(int(errorRow.code)) : null);
    const message = str(errorRow.error_message) ?? str(errorRow.message) ?? 'Error de la API';
    return { payload: classifySistrixError(code, message), credits, creditsKnown };
  }
  if (body.answer === undefined) {
    return {
      payload: { kind: 'error', code: null, message: 'La API no devolvió datos' },
      credits,
      creditsKnown,
    };
  }
  const answer = firstArray(body.answer, []);
  const value = answer.length === 1 ? answer[0] : answer;
  return { payload: { kind: 'payload', value }, credits, creditsKnown };
}

/** Saldo de créditos de la respuesta del método `credits` de la API. */
export function parseApiCredits(body: unknown): number | null {
  if (!isObj(body)) return null;
  const answer = firstArray(body.answer, [])[0];
  const find = (v: unknown): number | null => {
    if (isObj(v)) {
      for (const key of ['value', 'credits', 'remaining']) {
        const n = int(v[key]);
        if (n !== null) return n;
      }
      for (const inner of Object.values(v)) {
        const n = find(inner);
        if (n !== null) return n;
      }
    }
    if (Array.isArray(v))
      for (const inner of v) {
        const n = find(inner);
        if (n !== null) return n;
      }
    return null;
  };
  return find(answer);
}
