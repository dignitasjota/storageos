/** Tipo de entidad de un resultado de la búsqueda global. */
export type SearchResultType = 'customer' | 'contract' | 'unit' | 'invoice';

/** Un resultado de la búsqueda global del panel. */
export interface SearchResultDto {
  type: SearchResultType;
  id: string;
  label: string;
  detail: string | null;
  /** Ruta del panel a la que navegar. */
  href: string;
}

export interface SearchResultsDto {
  results: SearchResultDto[];
}
