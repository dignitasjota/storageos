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
  'collections_month',
  'move_outs_period',
  'owner_statement',
  'analytics_month',
  'debtors_by_customer',
  'contracts_ending',
  'free_units',
  'deposits_held',
  'invoicing_by_unit_type',
  'leads_by_source',
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
  price: z.number().positive().max(999_999),
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

/** Aplicar de una vez las sugerencias de precio de varios trasteros. */
export const ApplyUnitPricingManySchema = z.object({
  items: z
    .array(
      z.object({
        unitId: z.string().uuid(),
        price: z.number().positive().max(999_999),
      }),
    )
    .min(1)
    .max(500),
});
export type ApplyUnitPricingManyInput = z.infer<typeof ApplyUnitPricingManySchema>;

/** Vista previa: el mismo informe sin formato (no se guarda). */
export const PreviewReportSchema = z.object({
  generator: ReportGeneratorCodeEnum,
  params: z.record(z.unknown()).default({}),
});
export type PreviewReportInput = z.infer<typeof PreviewReportSchema>;

export const ReportScheduleFrequencyEnum = z.enum(['weekly', 'monthly']);
export type ReportScheduleFrequency = z.infer<typeof ReportScheduleFrequencyEnum>;

/**
 * Envío de un informe por correo. Las fechas no se eligen: se usa el periodo
 * anterior (la semana o el mes que acaba de terminar).
 */
export const CreateReportScheduleSchema = z
  .object({
    generator: ReportGeneratorCodeEnum,
    format: ReportFormatEnum.default('pdf'),
    params: z.record(z.unknown()).default({}),
    frequency: ReportScheduleFrequencyEnum,
    /** 1 (lunes) a 7 (domingo). */
    weekday: z.number().int().min(1).max(7).optional(),
    /** 1 a 28 (todos los meses lo tienen). */
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    hour: z.number().int().min(0).max(23).default(8),
    recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(5),
  })
  .refine(
    (v) => (v.frequency === 'weekly' ? v.weekday !== undefined : v.dayOfMonth !== undefined),
    {
      message: 'Elige el día del envío',
      path: ['frequency'],
    },
  );
export type CreateReportScheduleInput = z.infer<typeof CreateReportScheduleSchema>;

export const UpdateReportScheduleSchema = z.object({
  isActive: z.boolean().optional(),
  recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(5).optional(),
  hour: z.number().int().min(0).max(23).optional(),
});
export type UpdateReportScheduleInput = z.infer<typeof UpdateReportScheduleSchema>;
