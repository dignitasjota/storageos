import type { AnalyticsScope } from '../../analytics/analytics-scope';
import type { Permission, ReportFormatValue, ReportGeneratorCode } from '@storageos/shared';

/**
 * Resultado generico de un generator: filas + columnas + meta. Cada
 * renderer (PDF / Excel) consume este formato comun.
 */
export interface ReportResult {
  title: string;
  subtitle?: string;
  generatedAt: Date;
  /** Zona horaria del negocio (para la fecha del pie). */
  timezone?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Resumen agregado (totales, etc.) opcional, se pinta al final. */
  summary?: { label: string; value: string }[];
  /** Nombre, color y logo del negocio (los pone el servicio, no el informe). */
  brand?: ReportBrand;
}

export interface ReportBrand {
  name: string | null;
  /** `#rrggbb` o null. */
  color: string | null;
  /** Logo subido, ya en `data:` (sin descargar nada de fuera). */
  logoDataUri: string | null;
}

export interface ReportColumn {
  key: string;
  label: string;
  /** Para formateo: text por defecto. `date` espera `AAAA-MM-DD`. */
  type?: 'text' | 'number' | 'currency' | 'date';
  width?: number;
  align?: 'left' | 'right' | 'center';
}

export type ReportRow = Record<string, string | number | null | undefined>;

export interface ReportGeneratorContext {
  tenantId: string;
  params: Record<string, unknown>;
  /** Locales de quien lo pidió, con el local elegido si lo hay. */
  scope: AnalyticsScope;
  /** Zona horaria del negocio. */
  timezone: string;
}

export interface ReportParamDef {
  label: string;
  type: 'date' | 'period' | 'select' | 'text' | 'number';
  required: boolean;
  options?: { value: string; label: string }[];
}

export interface ReportGenerator {
  code: ReportGeneratorCode | string;
  name: string;
  description: string;
  /** Formatos soportados; default: pdf + xlsx. */
  formats: ReportFormatValue[];
  /** Definicion de params para que el frontend pinte el formulario. */
  paramsSchema: Record<string, ReportParamDef>;
  /** Permisos que hacen falta para pedirlo y verlo (los que llevan dinero). */
  requires?: Permission[];
  /** De toda la empresa: no se ofrece a quien solo ve algunos locales. */
  companyWide?: boolean;
  /** Admite elegir un local (se añade el desplegable «Local»). */
  byFacility?: boolean;
  /**
   * Comprueba los parámetros al pedir el informe: lanza 400 con un mensaje
   * claro en vez de dejar un informe fallido.
   */
  validate?(params: Record<string, unknown>): void;
  /**
   * Opciones que dependen del tenant (p. ej. sus propietarios). Devuelve null
   * para que el informe no salga en el catálogo de ese tenant.
   */
  loadOptions?(
    tenantId: string,
  ): Promise<Record<string, { value: string; label: string }[]> | null>;
  run(ctx: ReportGeneratorContext): Promise<ReportResult>;
}
