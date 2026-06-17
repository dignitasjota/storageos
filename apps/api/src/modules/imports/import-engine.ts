import Papa from 'papaparse';

import type {
  ImportCommitDto,
  ImportCommitRowResult,
  ImportDuplicatePolicy,
  ImportPreviewDto,
  ImportPreviewRowDto,
  ImportRowStatus,
} from '@storageos/shared';

/** Resultado de evaluar una fila: estado + errores + (si procede) la acción de creación. */
export interface RowEval {
  status: ImportRowStatus;
  errors: string[];
  /** Crea la entidad y devuelve su id. Ausente cuando status = 'error'. */
  create?: () => Promise<string>;
}

export type RowEvaluator = (raw: Record<string, string>, index: number) => RowEval;

/** Parser CSV genérico (cabecera + filas), tolerante a comillas y comas internas. */
export function parseRaw(csv: string): { columns: string[]; records: Record<string, string>[] } {
  const result = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  return { columns: result.meta.fields ?? [], records: result.data ?? [] };
}

/** Normaliza una cabecera para casarla con alias (sin acentos, espacios ni mayúsculas). */
export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_]+/g, '');
}

/** Casa las cabeceras del CSV con campos canónicos vía alias. */
export function resolveColumns<F extends string>(
  columns: string[],
  aliases: Record<string, F>,
): Map<string, F> {
  const map = new Map<string, F>();
  for (const col of columns) {
    const field = aliases[normalizeHeader(col)];
    if (field) map.set(col, field);
  }
  return map;
}

export function flattenZodErrors(error: {
  issues: { path: (string | number)[]; message: string }[];
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/** Convierte un decimal en texto (admite coma decimal española) a número, o null. */
export function parseDecimal(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Normaliza una fecha a YYYY-MM-DD (admite DD/MM/YYYY). Devuelve la entrada si no encaja. */
export function normalizeDate(value: string | undefined): string {
  const v = (value ?? '').trim();
  const dmy = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(v);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return v;
}

/** Construye la vista previa (dry-run) ejecutando el evaluador por fila. */
export function buildPreview(
  columns: string[],
  records: Record<string, string>[],
  evaluate: RowEvaluator,
): ImportPreviewDto {
  const rows: ImportPreviewRowDto[] = records.map((raw, i) => {
    const ev = evaluate(raw, i);
    return { index: i + 1, raw, status: ev.status, errors: ev.errors };
  });
  return {
    columns,
    summary: {
      total: rows.length,
      valid: rows.filter((r) => r.status === 'valid').length,
      invalid: rows.filter((r) => r.status === 'error').length,
      duplicates: rows.filter((r) => r.status === 'duplicate').length,
    },
    rows,
  };
}

/** Ejecuta la importación real respetando la política de duplicados. */
export async function runCommit(
  records: Record<string, string>[],
  evaluate: RowEvaluator,
  onDuplicate: ImportDuplicatePolicy,
): Promise<ImportCommitDto> {
  const results: ImportCommitRowResult[] = [];
  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    if (!raw) continue;
    const ev = evaluate(raw, i);
    if (ev.status === 'error' || !ev.create) {
      results.push({ index: i + 1, status: 'error', errors: ev.errors });
      continue;
    }
    if (ev.status === 'duplicate' && onDuplicate === 'skip') {
      results.push({ index: i + 1, status: 'skipped', errors: ev.errors });
      continue;
    }
    try {
      const id = await ev.create();
      results.push({ index: i + 1, status: 'created', id });
    } catch (err) {
      results.push({
        index: i + 1,
        status: 'error',
        errors: [err instanceof Error ? err.message : 'Error desconocido'],
      });
    }
  }
  return {
    summary: {
      created: results.filter((r) => r.status === 'created').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errors: results.filter((r) => r.status === 'error').length,
    },
    rows: results,
  };
}
