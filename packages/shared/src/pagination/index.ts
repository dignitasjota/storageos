/** Página de una lista paginada por cursor (`nextCursor` null = no hay más). */
export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}

/** Filas por página de las listas del panel. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
