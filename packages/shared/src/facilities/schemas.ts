import { z } from 'zod';

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color invalido. Usa formato #RRGGBB');

const positiveDecimal = z
  .number({ invalid_type_error: 'Debe ser un numero' })
  .positive('Debe ser positivo')
  .finite();

const nonNegativeDecimal = z
  .number({ invalid_type_error: 'Debe ser un numero' })
  .nonnegative('No puede ser negativo')
  .finite();

const facilityName = z.string().trim().min(2, 'Minimo 2 caracteres').max(120);
const optionalShortText = z.string().trim().max(200).optional().or(z.literal(''));

// ============================================================================
// Facilities
// ============================================================================

export const CreateFacilitySchema = z.object({
  name: facilityName,
  /** Slug público opcional para la landing SEO; si se omite, se genera del nombre. */
  publicSlug: z.string().trim().max(60).optional().or(z.literal('')),
  address: optionalShortText,
  city: optionalShortText,
  postalCode: z.string().trim().max(20).optional().or(z.literal('')),
  country: z
    .string()
    .trim()
    .length(2, 'Codigo de pais ISO 3166-1 alfa-2 (2 letras)')
    .toUpperCase()
    .default('ES'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  timezone: z.string().trim().min(1).default('Europe/Madrid'),
  contactPhone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[+\d\s().-]+$/, 'Telefono no valido')
    .optional()
    .or(z.literal('')),
  contactEmail: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
});
export type CreateFacilityInput = z.infer<typeof CreateFacilitySchema>;

export const UpdateFacilitySchema = CreateFacilitySchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateFacilityInput = z.infer<typeof UpdateFacilitySchema>;

// ============================================================================
// Unit Types
// ============================================================================

export const CreateUnitTypeSchema = z.object({
  name: z.string().trim().min(1, 'Obligatorio').max(80),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  defaultPriceMonthly: nonNegativeDecimal,
  color: hexColor.default('#888888'),
  features: z.record(z.unknown()).default({}),
});
export type CreateUnitTypeInput = z.infer<typeof CreateUnitTypeSchema>;

export const UpdateUnitTypeSchema = CreateUnitTypeSchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateUnitTypeInput = z.infer<typeof UpdateUnitTypeSchema>;

// ============================================================================
// Units
// ============================================================================

export const UnitStatusEnum = z.enum([
  'available',
  'occupied',
  'reserved',
  'maintenance',
  'blocked',
]);
export type UnitStatusValue = z.infer<typeof UnitStatusEnum>;

export const CreateUnitSchema = z.object({
  facilityId: z.string().uuid(),
  floorId: z.string().uuid().optional(),
  unitTypeId: z.string().uuid(),
  code: z
    .string()
    .trim()
    .min(1, 'Obligatorio')
    .max(40)
    .regex(/^[A-Za-z0-9_\-./]+$/, 'Solo letras, numeros y -_./'),
  widthM: positiveDecimal,
  depthM: positiveDecimal,
  heightM: positiveDecimal,
  basePriceMonthly: nonNegativeDecimal.optional(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type CreateUnitInput = z.infer<typeof CreateUnitSchema>;

export const UpdateUnitSchema = z
  .object({
    floorId: z.string().uuid().optional(),
    unitTypeId: z.string().uuid().optional(),
    code: CreateUnitSchema.shape.code.optional(),
    widthM: positiveDecimal.optional(),
    depthM: positiveDecimal.optional(),
    heightM: positiveDecimal.optional(),
    basePriceMonthly: nonNegativeDecimal.optional(),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateUnitInput = z.infer<typeof UpdateUnitSchema>;

export const ChangeUnitStatusSchema = z.object({
  status: UnitStatusEnum,
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});
export type ChangeUnitStatusInput = z.infer<typeof ChangeUnitStatusSchema>;

// ============================================================================
// Floors + layout
// ============================================================================

export const CreateFloorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  floorNumber: z.number().int().min(-10).max(50).default(0),
});
export type CreateFloorInput = z.infer<typeof CreateFloorSchema>;

export const UpdateFloorSchema = CreateFloorSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdateFloorInput = z.infer<typeof UpdateFloorSchema>;

export const UpdateFloorPlanSchema = z.object({
  planImageUrl: z.string().url(),
  planWidthPx: z.number().int().positive().max(20_000),
  planHeightPx: z.number().int().positive().max(20_000),
});
export type UpdateFloorPlanInput = z.infer<typeof UpdateFloorPlanSchema>;

const planCoord = z.number().finite().min(-100_000).max(100_000);
const planSize = z.number().finite().positive().max(100_000);

export const UnitLayoutItemSchema = z.object({
  id: z.string().uuid(),
  planX: planCoord,
  planY: planCoord,
  planWidth: planSize,
  planHeight: planSize,
});
export type UnitLayoutItem = z.infer<typeof UnitLayoutItemSchema>;

export const UpdateUnitsLayoutSchema = z.object({
  units: z.array(UnitLayoutItemSchema).min(0).max(2_000),
});
export type UpdateUnitsLayoutInput = z.infer<typeof UpdateUnitsLayoutSchema>;

// ============================================================================
// MinIO upload
// ============================================================================

export const RequestPlanUploadSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024, 'Maximo 5 MB'),
});
export type RequestPlanUploadInput = z.infer<typeof RequestPlanUploadSchema>;
