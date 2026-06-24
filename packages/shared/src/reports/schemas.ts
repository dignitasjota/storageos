import { z } from 'zod';

export const ReportFormatEnum = z.enum(['pdf', 'xlsx']);
export type ReportFormatValue = z.infer<typeof ReportFormatEnum>;

export const ReportStatusEnum = z.enum(['pending', 'running', 'done', 'failed', 'expired']);
export type ReportStatusValue = z.infer<typeof ReportStatusEnum>;

/**
 * Identificador de generator. Los services del backend registran los
 * generators conocidos; el frontend pide uno por codigo. Mantener
 * sincronizado con `REPORT_GENERATORS` en `apps/api`.
 */
export const ReportGeneratorCodeEnum = z.enum([
  'invoices_period',
  'contracts_active',
  'occupancy_snapshot',
  'aging_at_date',
  'leads_period',
  'product_sales_period',
]);
export type ReportGeneratorCode = z.infer<typeof ReportGeneratorCodeEnum>;

export const RunReportSchema = z.object({
  generator: ReportGeneratorCodeEnum,
  format: ReportFormatEnum.default('pdf'),
  params: z.record(z.unknown()).default({}),
});
export type RunReportInput = z.infer<typeof RunReportSchema>;

/** Aplica el nuevo precio de catálogo a un tipo de trastero (yield management). */
export const ApplyPricingSchema = z.object({
  unitTypeId: z.string().uuid(),
  price: z.number().positive().max(100000),
});
export type ApplyPricingInput = z.infer<typeof ApplyPricingSchema>;
