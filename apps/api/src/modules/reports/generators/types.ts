import type { ReportFormatValue, ReportGeneratorCode } from '@storageos/shared';

/**
 * Resultado generico de un generator: filas + columnas + meta. Cada
 * renderer (PDF / Excel) consume este formato comun.
 */
export interface ReportResult {
  title: string;
  subtitle?: string;
  generatedAt: Date;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Resumen agregado (totales, etc.) opcional, se pinta al final. */
  summary?: { label: string; value: string }[];
}

export interface ReportColumn {
  key: string;
  label: string;
  /** Para formateo: text por defecto. */
  type?: 'text' | 'number' | 'currency' | 'date';
  width?: number;
  align?: 'left' | 'right' | 'center';
}

export type ReportRow = Record<string, string | number | null | undefined>;

export interface ReportGeneratorContext {
  tenantId: string;
  params: Record<string, unknown>;
}

export interface ReportGenerator {
  code: ReportGeneratorCode | string;
  name: string;
  description: string;
  /** Formatos soportados; default: pdf + xlsx. */
  formats: ReportFormatValue[];
  /** Definicion de params para que el frontend pinte el formulario. */
  paramsSchema: Record<
    string,
    {
      label: string;
      type: 'date' | 'period' | 'select' | 'text' | 'number';
      required: boolean;
      options?: { value: string; label: string }[];
    }
  >;
  run(ctx: ReportGeneratorContext): Promise<ReportResult>;
}
