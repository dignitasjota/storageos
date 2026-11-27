import { BadRequestException } from '@nestjs/common';
import {
  SEO_PERIODS,
  SEO_TABLE_PAGE_SIZE,
  SEO_TABLE_SORTS,
  isSeoBrandFilter,
  isSeoPanelPeriod,
  type SeoTableSort,
} from '@storageos/shared';

import type { SeoPanelQuery, SeoTableQuery } from './seo-panel.service';

/** Periodo del resumen: 7, 28 o 90 días (28 por defecto). */
export function parseSeoDays(value: string | undefined): number {
  const n = Number(value);
  return (SEO_PERIODS as readonly number[]).includes(n) ? n : 28;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parámetros comunes del panel: `period`, `from`, `to` (personalizado) y `domainId`. */
export function parsePanelQuery(q: Record<string, string | undefined>): SeoPanelQuery {
  if (q.domainId && !UUID_RE.test(q.domainId)) {
    throw new BadRequestException({ code: 'invalid_id', message: 'Dominio no válido.' });
  }
  const area = q.area?.trim().slice(0, 80);
  return {
    period: isSeoPanelPeriod(q.period) ? q.period : '28d',
    from: q.from,
    to: q.to,
    domainId: q.domainId || undefined,
    brand: isSeoBrandFilter(q.brand) ? q.brand : undefined,
    area: area || undefined,
  };
}

/** Además: búsqueda, orden, sentido y página («Cargar más»). */
export function parseTableQuery(q: Record<string, string | undefined>): SeoTableQuery {
  const sort = (SEO_TABLE_SORTS as readonly string[]).includes(q.sort ?? '')
    ? (q.sort as SeoTableSort)
    : 'clicks';
  const limit = Number.parseInt(q.limit ?? '', 10);
  const offset = Number.parseInt(q.offset ?? '', 10);
  return {
    ...parsePanelQuery(q),
    search: q.search,
    sort,
    dir: q.dir === 'asc' || q.dir === 'desc' ? q.dir : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : SEO_TABLE_PAGE_SIZE,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

/** `domainId` del formulario de subida (multipart). */
export function parseUploadDomainId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BadRequestException({
      code: 'seo_import_domain_required',
      message: 'Elige el dominio al que pertenece el fichero.',
    });
  }
  return value;
}

/** Dimensión del cruce búsqueda ↔ página. */
export function parseCrossDimension(value: string | undefined): 'query' | 'page' {
  if (value === 'query' || value === 'page') return value;
  throw new BadRequestException({ code: 'invalid_dimension', message: 'Dimensión no válida.' });
}
