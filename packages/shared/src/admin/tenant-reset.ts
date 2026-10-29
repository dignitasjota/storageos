import { z } from 'zod';

/**
 * Vaciado de los datos de prueba de un tenant antes de empezar en real: borra
 * inquilinos, contratos, reservas, facturas, cobros, ventas, gastos y todo lo
 * que cuelga de ellos. Conserva locales, trasteros, productos, contactos
 * (leads), usuarios y la configuración; las series vuelven a empezar en 1.
 */

/** Lo que se borra, en el orden en que se enseña en la vista previa. */
export const TENANT_RESET_COUNT_KEYS = [
  'customers',
  'contracts',
  'reservations',
  'invoices',
  'payments',
  'productSales',
  'expenses',
  'communications',
  'tasks',
  'incidents',
  'accessLogs',
] as const;
export type TenantResetCountKey = (typeof TENANT_RESET_COUNT_KEYS)[number];

export const TENANT_RESET_COUNT_LABELS: Record<TenantResetCountKey, string> = {
  customers: 'Inquilinos',
  contracts: 'Contratos',
  reservations: 'Reservas',
  invoices: 'Facturas y justificantes',
  payments: 'Cobros',
  productSales: 'Ventas de productos',
  expenses: 'Gastos',
  communications: 'Correos y mensajes enviados',
  tasks: 'Tareas',
  incidents: 'Incidencias',
  accessLogs: 'Registros de acceso',
};

/** Motivos por los que no se puede vaciar (datos que ya son reales). */
export type TenantResetBlockerCode =
  | 'aeat_production_invoices'
  | 'holded_issued_invoices'
  | 'platform_own_tenant'
  | 'platform_invoices';

/** Avisos que no bloquean pero conviene leer antes. */
export type TenantResetWarningCode =
  | 'holded_documents'
  | 'gateway_payments'
  | 'aeat_sent_invoices'
  | 'synced_credentials';

export interface TenantResetIssueDto<C extends string> {
  code: C;
  message: string;
  count: number;
}

export interface TenantResetPreviewDto {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  counts: Record<TenantResetCountKey, number>;
  /** Lo que se conserva, para que quede claro. */
  kept: { facilities: number; units: number; products: number; leads: number; users: number };
  /** Series que vuelven a 1 (prefijo y siguiente número actual). */
  series: { prefix: string; nextNumber: number }[];
  blockers: TenantResetIssueDto<TenantResetBlockerCode>[];
  warnings: TenantResetIssueDto<TenantResetWarningCode>[];
  /** Ficheros que se borrarían, por tipo (las exportaciones se conservan). */
  files: TenantResetFilesDto[];
}

export interface TenantResetFilesDto {
  label: string;
  objects: number;
  bytes: number;
}

export const TenantResetSchema = z.object({
  /** Hay que escribir el identificador del tenant tal cual. */
  confirmSlug: z.string().trim().min(1),
  reason: z.string().trim().min(5).max(500),
  /** Confirmación de que se han exportado los datos antes. */
  exported: z.literal(true),
});
export type TenantResetInput = z.infer<typeof TenantResetSchema>;

export interface TenantResetResultDto {
  counts: Record<TenantResetCountKey, number>;
  unitsFreed: number;
  seriesReset: number;
  filesDeleted: number;
}
