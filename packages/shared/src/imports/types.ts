export type ImportRowStatus = 'valid' | 'error' | 'duplicate';

export interface ImportPreviewRowDto {
  /** Número de fila en el CSV (1 = primera fila de datos, sin contar cabecera). */
  index: number;
  /** Valores crudos de la fila, por columna. */
  raw: Record<string, string>;
  status: ImportRowStatus;
  /** Mensajes de validación (solo si status = 'error'). */
  errors: string[];
}

export interface ImportPreviewSummary {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
}

export interface ImportCustomersPreviewDto {
  /** Cabeceras detectadas en el CSV. */
  columns: string[];
  summary: ImportPreviewSummary;
  rows: ImportPreviewRowDto[];
}

export type ImportCommitRowStatus = 'created' | 'skipped' | 'error';

export interface ImportCommitRowResult {
  index: number;
  status: ImportCommitRowStatus;
  /** id del cliente creado (solo si status = 'created'). */
  id?: string;
  errors?: string[];
}

export interface ImportCommitSummary {
  created: number;
  skipped: number;
  errors: number;
}

export interface ImportCustomersCommitDto {
  summary: ImportCommitSummary;
  rows: ImportCommitRowResult[];
}
