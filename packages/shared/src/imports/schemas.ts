import { z } from 'zod';

/** Tamaño máximo del CSV en texto (~2 MB). Evita payloads abusivos. */
const csvText = z.string().min(1).max(2_000_000);

export const ImportDuplicatePolicyEnum = z.enum(['skip', 'create']);
export type ImportDuplicatePolicy = z.infer<typeof ImportDuplicatePolicyEnum>;

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
export const ImportPreviewSchema = z.object({ csv: csvText });
export type ImportPreviewInput = z.infer<typeof ImportPreviewSchema>;

export const ImportCommitSchema = z.object({
  csv: csvText,
  onDuplicate: ImportDuplicatePolicyEnum.default('skip'),
});
export type ImportCommitInput = z.infer<typeof ImportCommitSchema>;
