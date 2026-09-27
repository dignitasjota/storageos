import type { SuggestedActionDto } from '@storageos/shared';

/**
 * Enriquecimiento con IA de «Sugerencias de hoy». Las acciones las calcula el
 * motor heurístico (determinista); el modelo SOLO reordena y redacta mejor el
 * título/detalle. Nunca inventa acciones: se descarta cualquier id que no
 * venga del motor, y el enlace/categoría/prioridad son siempre los originales.
 */

export const SUGGESTED_ACTIONS_SYSTEM_PROMPT = `Eres el asistente de un operador de trasteros (self-storage) en España.
Recibes una lista de acciones sugeridas para hoy en JSON. Tu tarea:
1. Ordénalas de más a menos importante para el negocio hoy (dinero en riesgo y bajas primero).
2. Reescribe "title" (máx. 70 caracteres, imperativo, concreto) y "detail" (máx. 140 caracteres) en español, claros y útiles. Conserva cifras, nombres y códigos EXACTOS; no inventes datos.
Devuelve SOLO JSON válido con esta forma, sin texto adicional:
{"actions":[{"id":"<id original>","title":"...","detail":"..."}]}
Usa únicamente los ids recibidos.`;

export function buildSuggestedActionsPrompt(actions: SuggestedActionDto[]): string {
  return JSON.stringify({
    actions: actions.map((a) => ({
      id: a.id,
      category: a.category,
      priority: a.priority,
      title: a.title,
      detail: a.detail,
    })),
  });
}

const TITLE_MAX = 80;
const DETAIL_MAX = 160;

/**
 * Aplica la respuesta del modelo. Devuelve `null` si no es JSON válido o no
 * reconoce ningún id (el llamador cae a la lista heurística). Las acciones que
 * el modelo omita se conservan al final en su orden original.
 */
export function applySuggestedActionsRanking(
  actions: SuggestedActionDto[],
  raw: string,
): SuggestedActionDto[] | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.actions)) return null;

  const byId = new Map(actions.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const ranked: SuggestedActionDto[] = [];
  for (const item of parsed.actions as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, detail } = item as Record<string, unknown>;
    if (typeof id !== 'string' || seen.has(id)) continue;
    const original = byId.get(id);
    if (!original) continue;
    seen.add(id);
    ranked.push({
      ...original,
      title: cleanText(title, TITLE_MAX) ?? original.title,
      detail: cleanText(detail, DETAIL_MAX) ?? original.detail,
    });
  }
  if (ranked.length === 0) return null;
  for (const a of actions) if (!seen.has(a.id)) ranked.push(a);
  return ranked;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Extrae el primer objeto JSON del texto (el modelo a veces lo envuelve en ```). */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
