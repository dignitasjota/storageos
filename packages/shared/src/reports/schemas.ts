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

/** Aplicar la sugerencia de precio a un trastero individual (fija basePriceMonthly). */
export const ApplyUnitPricingSchema = z.object({
  unitId: z.string().uuid(),
  price: z.number().nonnegative().max(1_000_000),
});
export type ApplyUnitPricingInput = z.infer<typeof ApplyUnitPricingSchema>;

export const UpdatePricingStrategySchema = z.object({
  targetOccupancy: z.number().int().min(50).max(100).optional(),
  maxStepPct: z.number().int().min(1).max(30).optional(),
  minDaysBetweenChanges: z.number().int().min(0).max(365).optional(),
  facilities: z
    .array(z.object({ id: z.string().uuid(), positioningPct: z.number().int().min(-30).max(30) }))
    .max(500)
    .optional(),
  unitTypes: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          minPrice: z.number().nonnegative().max(1_000_000).nullable(),
          maxPrice: z.number().nonnegative().max(1_000_000).nullable(),
        })
        .refine((v) => v.minPrice == null || v.maxPrice == null || v.minPrice <= v.maxPrice, {
          message: 'El mínimo no puede ser mayor que el máximo',
          path: ['minPrice'],
        }),
    )
    .max(500)
    .optional(),
});
export type UpdatePricingStrategyInput = z.infer<typeof UpdatePricingStrategySchema>;
