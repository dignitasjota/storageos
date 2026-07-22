import { z } from 'zod';

/** Tamaño máximo del CSV en texto (~2 MB). Evita payloads abusivos. */
const csvText = z.string().min(1).max(2_000_000);

export const ImportDuplicatePolicyEnum = z.enum(['skip', 'create']);
export type ImportDuplicatePolicy = z.infer<typeof ImportDuplicatePolicyEnum>;

/**
 * Formato del contenido enviado en `csv`. Con `xlsx`, el campo `csv` transporta
 * el fichero XLSX en base64 (el backend lo convierte a CSV con exceljs antes de
 * procesarlo). Default `csv` = texto plano, retrocompatible.
 */
export const ImportFormatEnum = z.enum(['csv', 'xlsx']);
export type ImportFormat = z.infer<typeof ImportFormatEnum>;

export const ImportCustomersPreviewSchema = z.object({
  csv: csvText,
});
export type ImportCustomersPreviewInput = z.infer<typeof ImportCustomersPreviewSchema>;

export const ImportCustomersCommitSchema = z.object({
  csv: csvText,
  /** Qué hacer con filas cuyo email/documento ya existe. Default: omitir. */
  onDuplicate: ImportDuplicatePolicyEnum.default('skip'),
});
export type ImportCustomersCommitInput = z.infer<typeof ImportCustomersCommitSchema>;

/** Schemas genéricos reutilizables por cualquier entidad importable (trasteros, contratos…). */
export const ImportPreviewSchema = z.object({
  csv: csvText,
  format: ImportFormatEnum.default('csv'),
});
export type ImportPreviewInput = z.infer<typeof ImportPreviewSchema>;

export const ImportCommitSchema = z.object({
  csv: csvText,
  format: ImportFormatEnum.default('csv'),
  onDuplicate: ImportDuplicatePolicyEnum.default('skip'),
});
export type ImportCommitInput = z.infer<typeof ImportCommitSchema>;
