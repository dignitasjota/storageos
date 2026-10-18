import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type PageDto } from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Página pedida: id de la última fila vista y tamaño. */
export interface PageRequest {
  cursor?: string;
  limit: number;
}

/** Valida `?cursor=&limit=` de los endpoints `/page` (400 si el cursor no es un id). */
export function parsePageRequest(cursor?: string, limit?: string): PageRequest {
  if (cursor && !UUID_RE.test(cursor)) {
    throw new BadRequestException({ code: 'invalid_cursor', message: 'Cursor no válido' });
  }
  const n = Number.parseInt(limit ?? '', 10);
  return {
    ...(cursor ? { cursor } : {}),
    limit: Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
  };
}

/**
 * Argumentos de Prisma para una página por cursor. Pide una fila de más para
 * saber si hay siguiente página. El `orderBy` debe terminar en `id` para que
 * el orden sea estable.
 */
export function pageArgs(page?: PageRequest): {
  take?: number;
  skip?: number;
  cursor?: { id: string };
} {
  if (!page) return {};
  return {
    take: page.limit + 1,
    ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
  };
}

/** Corta la fila de más y calcula el cursor de la siguiente página. */
export function toPage<T extends { id: string }>(rows: T[], page: PageRequest): PageDto<T> {
  const hasMore = rows.length > page.limit;
  const items = hasMore ? rows.slice(0, page.limit) : rows;
  return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
}
