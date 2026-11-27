import { seoUrlInPath, type SeoCompetitionMoverDto } from '@storageos/shared';

/** Una fila de resultado de Google de una palabra y fecha. */
export interface SerpRow {
  keywordId: string;
  /** 1 = la última muestra de esa palabra; 2 = la anterior. */
  rank: number;
  sampleDate: string;
  position: number;
  domain: string;
  url: string;
  title: string | null;
}

export interface TrackedDomain {
  domain: string;
  own: boolean;
  /** Directorio que se analiza (competidor de un directorio). */
  pathPrefix: string | null;
}

export const stripWww = (d: string) => d.replace(/^www\./, '').toLowerCase();

/** Fila del dominio y, si lo tiene, dentro de su directorio. */
export function rowBelongs(row: Pick<SerpRow, 'domain' | 'url'>, d: TrackedDomain): boolean {
  return stripWww(row.domain) === d.domain && seoUrlInPath(row.url, d.pathPrefix);
}

/** Mejor posición del dominio en una muestra (si sale varias veces, la mejor). */
export function bestRow(rows: readonly SerpRow[], d: TrackedDomain): SerpRow | null {
  let best: SerpRow | null = null;
  for (const r of rows) {
    if (!rowBelongs(r, d)) continue;
    if (!best || r.position < best.position) best = r;
  }
  return best;
}

/**
 * Cambios entre las dos últimas muestras de cada palabra: por dominio y
 * palabra, de dónde viene y a dónde va. Una palabra sin dos muestras no se
 * compara (se cuenta aparte).
 */
export function buildMovers(input: {
  rows: readonly SerpRow[];
  domains: readonly TrackedDomain[];
  keywords: ReadonlyMap<string, { keyword: string; group: string | null }>;
}): {
  items: SeoCompetitionMoverDto[];
  withoutHistory: number;
  from: string | null;
  to: string | null;
} {
  const byKeyword = new Map<string, SerpRow[]>();
  for (const r of input.rows) {
    const list = byKeyword.get(r.keywordId) ?? [];
    list.push(r);
    byKeyword.set(r.keywordId, list);
  }
  const items: SeoCompetitionMoverDto[] = [];
  let withoutHistory = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const [keywordId, meta] of input.keywords) {
    const rows = byKeyword.get(keywordId) ?? [];
    const now = rows.filter((r) => r.rank === 1);
    const before = rows.filter((r) => r.rank === 2);
    if (now.length === 0 || before.length === 0) {
      withoutHistory++;
      continue;
    }
    const nowDate = now[0]!.sampleDate;
    const beforeDate = before[0]!.sampleDate;
    if (to === null || nowDate > to) to = nowDate;
    if (from === null || beforeDate < from) from = beforeDate;
    for (const d of input.domains) {
      const a = bestRow(before, d);
      const b = bestRow(now, d);
      if (!a && !b) continue;
      const diff = a && b ? a.position - b.position : null;
      if (a && b && diff === 0) continue;
      const pick = b ?? a!;
      items.push({
        domain: d.domain,
        own: d.own,
        keyword: meta.keyword,
        group: meta.group,
        previous: a ? a.position : null,
        current: b ? b.position : null,
        diff,
        url: pick.url,
        title: pick.title,
      });
    }
  }
  return { items, withoutHistory, from, to };
}

/** Peso de un cambio para ordenar: los grandes primero; entrar o salir cuenta como 20. */
export function moverWeight(m: Pick<SeoCompetitionMoverDto, 'diff'>): number {
  return m.diff === null ? 20 : Math.abs(m.diff);
}
