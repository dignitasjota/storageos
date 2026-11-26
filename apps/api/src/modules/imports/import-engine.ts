import ExcelJS from 'exceljs';
import Papa from 'papaparse';

import { normalizeOpenXmlPackage } from './openxml-normalize';

import type {
  ImportCommitDto,
  ImportCommitRowResult,
  ImportDuplicatePolicy,
  ImportFormat,
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

/** Valor de celda de exceljs → texto plano (resuelve fórmulas, fechas, hyperlinks…). */
export function cellToText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) {
    // Fecha → YYYY-MM-DD (los importadores ya normalizan formatos).
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    const v = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.result != null) return String(v.result);
    return '';
  }
  return String(value);
}

const toArrayBuffer = (buffer: Buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

/**
 * Abre un XLSX con exceljs. Si no puede (los Excel del OpenXML SDK, con el
 * prefijo `x:` y destinos absolutos), lo normaliza y lo vuelve a intentar.
 */
export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  let failure: unknown = null;
  try {
    await wb.xlsx.load(toArrayBuffer(buffer));
    // Sin hojas leídas también puede ser un paquete que exceljs no entiende.
    if (wb.worksheets.length > 0) return wb;
  } catch (err) {
    failure = err;
  }
  const normalized = await normalizeOpenXmlPackage(buffer);
  if (!normalized) {
    if (failure) throw failure;
    return wb;
  }
  const retry = new ExcelJS.Workbook();
  await retry.xlsx.load(toArrayBuffer(normalized));
  return retry;
}

/**
 * Convierte un XLSX (base64) a CSV usando la PRIMERA hoja. La primera fila no
 * vacía se toma como cabecera. Se reusa `Papa.unparse` para escapar igual que
 * un CSV normal → el resto del pipeline (`parseRaw` + alias) no cambia.
 */
export async function xlsxBase64ToCsv(base64: string): Promise<string> {
  const wb = await loadWorkbook(Buffer.from(base64, 'base64'));
  const ws = wb.worksheets[0];
  if (!ws) return '';
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // row.values es 1-indexado (índice 0 = undefined); recorremos por columna.
    const count = Math.max(row.cellCount, (row.values as unknown[]).length - 1);
    for (let col = 1; col <= count; col++) {
      cells.push(cellToText(row.getCell(col).value).trim());
    }
    // Salta filas totalmente vacías.
    if (cells.some((c) => c !== '')) rows.push(cells);
  });
  if (rows.length === 0) return '';
  return Papa.unparse(rows);
}

/**
 * Todas las hojas de un XLSX como filas de texto (las filas vacías fuera). Lo
 * usa la importación de los Excel de Search Console, que trae varias pestañas.
 */
export async function xlsxSheets(buffer: Buffer): Promise<{ name: string; rows: string[][] }[]> {
  const wb = await loadWorkbook(buffer);
  return wb.worksheets.map((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      const count = Math.max(row.cellCount, (row.values as unknown[]).length - 1);
      for (let col = 1; col <= count; col++) {
        cells.push(cellToText(row.getCell(col).value).trim());
      }
      if (cells.some((c) => c !== '')) rows.push(cells);
    });
    return { name: ws.name, rows };
  });
}

/**
 * Normaliza el contenido de importación a CSV: si `format` es `xlsx`, `content`
 * es el XLSX en base64 y se convierte; si es `csv`, se devuelve tal cual.
 */
export async function resolveImportCsv(content: string, format: ImportFormat): Promise<string> {
  return format === 'xlsx' ? xlsxBase64ToCsv(content) : content;
}

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

/**
 * Locales por nombre (en minúsculas). Un nombre repetido no se puede resolver:
 * va en `ambiguous` para que la fila diga por qué falla en vez de caer en uno.
 */
export function facilitiesByName(facilities: { id: string; name: string }[]): {
  byName: Map<string, string>;
  ambiguous: Set<string>;
} {
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const f of facilities) {
    const key = f.name.trim().toLowerCase();
    if (byName.has(key)) ambiguous.add(key);
    byName.set(key, f.id);
  }
  for (const key of ambiguous) byName.delete(key);
  return { byName, ambiguous };
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
