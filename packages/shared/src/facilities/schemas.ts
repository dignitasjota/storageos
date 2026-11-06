import { z } from 'zod';

import { isValidTimeZone } from '../auth/schemas';
import { PropertyKindEnum } from '../billing/tax-category';
import { CompetitorFeatureEnum } from '../competitors';

import { UnitFeatureEnum, UnitPriceRoundEnum } from './unit-tools';

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

/** Lo que cabe en las columnas de medidas, superficie y volumen. */
const unitSide = positiveDecimal.max(500, 'Máximo 500 m');
const unitHeight = positiveDecimal.max(50, 'Máximo 50 m');
export const UNIT_MAX_PRICE = 999_999;
const unitPrice = nonNegativeDecimal.max(UNIT_MAX_PRICE, 'Máximo 999.999 €');

const facilityName = z
  .string()
  .trim()
  .min(2, 'Mínimo 2 caracteres')
  .max(120, 'Máximo 120 caracteres');
const optionalShortText = z.string().trim().max(200).optional().or(z.literal(''));

// ============================================================================
// Horario de apertura (opcional, se muestra en la web pública del local)
// ============================================================================

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM');

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

/**
 * Apertura antes del cierre («00:00» como cierre = medianoche; 00:00–00:00 = 24
 * horas). `open2`/`close2`: segundo turno de un horario partido, después del primero.
 */
export const DayHoursSchema = z
  .object({ open: hhmm, close: hhmm, open2: hhmm.optional(), close2: hhmm.optional() })
  .refine((d) => d.close === '00:00' || d.open < d.close, {
    message: 'La hora de apertura tiene que ser anterior a la de cierre',
    path: ['close'],
  })
  .refine((d) => !d.open2 === !d.close2, {
    message: 'Indica las dos horas del segundo turno',
    path: ['close2'],
  })
  .refine(
    (d) =>
      !d.open2 ||
      !d.close2 ||
      (d.close !== '00:00' && d.close <= d.open2 && (d.close2 === '00:00' || d.open2 < d.close2)),
    { message: 'El segundo turno tiene que ir después del primero', path: ['open2'] },
  );
export type DayHours = z.infer<typeof DayHoursSchema>;

/** `null` = cerrado ese día; ausente = sin configurar (se trata como cerrado). */
export const OpeningHoursSchema = z.object({
  mon: DayHoursSchema.nullable().optional(),
  tue: DayHoursSchema.nullable().optional(),
  wed: DayHoursSchema.nullable().optional(),
  thu: DayHoursSchema.nullable().optional(),
  fri: DayHoursSchema.nullable().optional(),
  sat: DayHoursSchema.nullable().optional(),
  sun: DayHoursSchema.nullable().optional(),
});
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

/** Festivo o día con otro horario: manda sobre el de la semana. `hours: null` = cerrado. */
export const OpeningExceptionSchema = z.object({
  date: isoDay,
  label: z.string().trim().max(80, 'Máximo 80 caracteres').optional(),
  hours: DayHoursSchema.nullable(),
});
export type OpeningException = z.infer<typeof OpeningExceptionSchema>;

// ============================================================================
// Facilities
// ============================================================================

export const CreateFacilitySchema = z.object({
  name: facilityName,
  /** Slug público opcional para la landing SEO; si se omite, se genera del nombre. */
  publicSlug: z.string().trim().max(60).optional().or(z.literal('')),
  /** Propietario del local (plan Administrador); null = el propio tenant. */
  ownerId: z.string().uuid().nullable().optional(),
  address: optionalShortText,
  city: optionalShortText,
  postalCode: z.string().trim().max(20).optional().or(z.literal('')),
  country: z
    .string()
    .trim()
    .length(2, 'Usa el código de 2 letras del país (ES, PT…)')
    .toUpperCase()
    .default('ES'),
  /** `null` quita la ubicación: se guardan las dos o ninguna. */
  latitude: z
    .number({ invalid_type_error: 'Tiene que ser un número' })
    .min(-90, 'Entre -90 y 90')
    .max(90, 'Entre -90 y 90')
    .nullable()
    .optional(),
  longitude: z
    .number({ invalid_type_error: 'Tiene que ser un número' })
    .min(-180, 'Entre -180 y 180')
    .max(180, 'Entre -180 y 180')
    .nullable()
    .optional(),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimeZone, 'Zona horaria no válida')
    .default('Europe/Madrid'),
  /** Horario de apertura semanal, para la web pública del local. */
  openingHours: OpeningHoursSchema.optional(),
  /** Festivos y días con otro horario. */
  openingExceptions: z.array(OpeningExceptionSchema).max(60, 'Máximo 60 días').optional(),
  /** Cómo llegar: indicaciones para la web, el área de clientes y el correo de bienvenida. */
  directions: z.string().trim().max(1000, 'Máximo 1.000 caracteres').optional().or(z.literal('')),
  /** Enlace de Google Maps para «Cómo llegar». */
  mapsUrl: z
    .string()
    .trim()
    .max(500, 'Máximo 500 caracteres')
    .url('Enlace no válido')
    .regex(/^https?:\/\//i, 'El enlace tiene que empezar por https://')
    .optional()
    .or(z.literal('')),
  /** Vídeo (YouTube/Vimeo) para la web pública del local. */
  videoUrl: z
    .string()
    .trim()
    .max(500, 'Máximo 500 caracteres')
    .url('Enlace no válido')
    .regex(/^https?:\/\//i, 'El enlace tiene que empezar por https://')
    .optional()
    .or(z.literal('')),
  contactPhone: z
    .string()
    .trim()
    .max(40, 'Máximo 40 caracteres')
    .regex(/^[+\d\s().-]+$/, 'Teléfono no válido')
    .optional()
    .or(z.literal('')),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email('Email no válido')
    .optional()
    .or(z.literal('')),
  /** Toque de queda de acceso: bloquea el acceso en la franja (zona horaria del local). */
  accessCurfewEnabled: z.boolean().optional(),
  accessCurfewStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM')
    .optional()
    .or(z.literal('')),
  accessCurfewEnd: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM')
    .optional()
    .or(z.literal('')),
  /** Características del local (las compara la sugerencia de precio con la competencia). */
  features: z.array(CompetitorFeatureEnum).max(10).optional(),
});
export type CreateFacilityInput = z.infer<typeof CreateFacilitySchema>;

export const UpdateFacilitySchema = CreateFacilitySchema.partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateFacilityInput = z.infer<typeof UpdateFacilitySchema>;

export const DuplicateFacilitySchema = z.object({ name: facilityName });
export type DuplicateFacilityInput = z.infer<typeof DuplicateFacilitySchema>;

/** Aviso a los inquilinos de un local (obras, corte de agua…): es de servicio, no comercial. */
export const FacilityMessageSchema = z.object({
  subject: z.string().trim().min(2, 'Mínimo 2 caracteres').max(200, 'Máximo 200 caracteres'),
  bodyText: z.string().trim().min(2, 'Mínimo 2 caracteres').max(20_000),
});
export type FacilityMessageInput = z.infer<typeof FacilityMessageSchema>;

// ============================================================================
// Unit Types
// ============================================================================

export const CreateUnitTypeSchema = z.object({
  name: z.string().trim().min(1, 'Obligatorio').max(80),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  defaultPriceMonthly: unitPrice,
  defaultDepositAmount: unitPrice.default(0),
  color: hexColor.default('#888888'),
  features: z.record(z.unknown()).default({}),
  /** Taquillas apilables de dos en dos (mismo hueco del plano). */
  stackable: z.boolean().default(false),
  /** Trastero o vivienda (la vivienda requiere el extra «Viviendas»). */
  propertyKind: PropertyKindEnum.default('storage'),
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

/**
 * Cambios de estado manuales permitidos desde cada estado. `occupied` solo lo
 * pone un contrato (o la reconciliación de inventario cuando hay contrato).
 */
/**
 * Cambios de estado a mano. «Reservado» no está: lo pone quien guarda el trastero
 * (reserva, aviso de la cola, traslado programado); a mano quedaba sin dueño.
 */
export const UNIT_STATUS_TRANSITIONS: Record<UnitStatusValue, UnitStatusValue[]> = {
  available: ['maintenance', 'blocked'],
  reserved: ['available', 'maintenance', 'blocked'],
  maintenance: ['available', 'blocked'],
  blocked: ['available', 'maintenance'],
  occupied: ['available', 'maintenance', 'blocked'],
};

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
  widthM: unitSide,
  depthM: unitSide,
  heightM: unitHeight,
  basePriceMonthly: unitPrice.optional(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  features: z.array(UnitFeatureEnum).max(20).optional(),
});
export type CreateUnitInput = z.infer<typeof CreateUnitSchema>;

export const UpdateUnitSchema = z
  .object({
    floorId: z.string().uuid().optional(),
    unitTypeId: z.string().uuid().optional(),
    code: CreateUnitSchema.shape.code.optional(),
    widthM: unitSide.optional(),
    depthM: unitSide.optional(),
    heightM: unitHeight.optional(),
    basePriceMonthly: unitPrice.optional(),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
    features: z.array(UnitFeatureEnum).max(20).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateUnitInput = z.infer<typeof UpdateUnitSchema>;

export const ChangeUnitStatusSchema = z.object({
  status: UnitStatusEnum,
  reason: z.string().trim().max(500).optional().or(z.literal('')),
  /** En mantenimiento: cuándo se prevé que vuelva al servicio. */
  until: isoDay.optional(),
  /** En mantenimiento: crea una tarea de mantenimiento ligada al trastero. */
  createTask: z.boolean().optional(),
});
export type ChangeUnitStatusInput = z.infer<typeof ChangeUnitStatusSchema>;

/** Apila dos taquillas del mismo tipo apilable en el mismo hueco del plano. */
export const StackUnitsSchema = z.object({
  targetUnitId: z.string().uuid(),
});
export type StackUnitsInput = z.infer<typeof StackUnitsSchema>;

// ============================================================================
// Floors + layout
// ============================================================================

export const CreateFloorSchema = z.object({
  name: z.string().trim().min(1, 'Ponle un nombre').max(80, 'Máximo 80 caracteres'),
  floorNumber: z
    .number()
    .int()
    .min(-10, 'Número de planta entre -10 y 50')
    .max(50, 'Número de planta entre -10 y 50')
    .default(0),
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

/**
 * Solicitud de URL firmada para subir una imagen del local. Límite bajado de
 * 5 MB a 2 MB (rendimiento: son fotos de marketing que se muestran en
 * miniatura en el listado/ficha pública, no planos técnicos — con
 * `images.unoptimized:true` en Next no se recomprimen en servidor, así que
 * el límite de subida es la única palanca; el frontend además comprime/
 * redimensiona en el navegador antes de subir, ver `compressImage`).
 */
export const RequestFacilityImageUploadSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024, 'Máximo 2 MB'),
});
export type RequestFacilityImageUploadInput = z.infer<typeof RequestFacilityImageUploadSchema>;

/** Confirma una imagen subida (por su key) o reordena la lista completa. */
export const SetFacilityImagesSchema = z.object({
  images: z.array(z.string().min(1).max(300)).max(12),
  /** Texto alternativo por clave (Google y lectores de pantalla). Sin él, el nombre del local. */
  alts: z.record(z.string().trim().max(150, 'Máximo 150 caracteres')).optional(),
});
export type SetFacilityImagesInput = z.infer<typeof SetFacilityImagesSchema>;

// ============================================================================
// Acciones en lote y alta masiva de trasteros
// ============================================================================

export const BulkUnitsActionSchema = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('status'),
      unitIds: z.array(z.string().uuid()).min(1).max(500),
      status: UnitStatusEnum,
      reason: z.string().trim().max(500).optional(),
    }),
    z.object({
      action: z.literal('type'),
      unitIds: z.array(z.string().uuid()).min(1).max(500),
      unitTypeId: z.string().uuid(),
    }),
    z.object({
      action: z.literal('floor'),
      unitIds: z.array(z.string().uuid()).min(1).max(500),
      floorId: z.string().uuid(),
    }),
    z.object({
      action: z.literal('price'),
      unitIds: z.array(z.string().uuid()).min(1).max(500),
      /** `set` = fijar el precio; `percent` = subir/bajar un %. */
      mode: z.enum(['set', 'percent']),
      value: z.number().finite().min(-90).max(UNIT_MAX_PRICE),
      round: UnitPriceRoundEnum.default('none'),
    }),
  ])
  .superRefine((input, ctx) => {
    if (input.action !== 'price') return;
    if (input.mode === 'set' && input.value <= 0) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Indica un precio mayor que 0' });
    }
    if (input.mode === 'percent' && (input.value === 0 || input.value > 1000)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Indica un % entre -90 y 1.000' });
    }
  });
export type BulkUnitsActionInput = z.infer<typeof BulkUnitsActionSchema>;

export interface BulkUnitsResultDto {
  updated: number;
  failed: { unitId: string; unitCode: string | null; code: string | null; error: string }[];
}

export const BulkCreateUnitsSchema = z.object({
  facilityId: z.string().uuid(),
  floorId: z.string().uuid().optional(),
  unitTypeId: z.string().uuid(),
  /** Prefijo del código («A-»). */
  prefix: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9_\-./]*$/, 'Solo letras, numeros y -_./'),
  start: z.number().int().min(0).max(99999),
  count: z.number().int().min(1).max(200),
  /** Cifras del número (2 → A-01). */
  padding: z.number().int().min(0).max(6).default(2),
  widthM: unitSide,
  depthM: unitSide,
  heightM: unitHeight,
  basePriceMonthly: unitPrice.optional(),
});
export type BulkCreateUnitsInput = z.infer<typeof BulkCreateUnitsSchema>;

/** Códigos que generaría el alta masiva. */
export function bulkUnitCodes(input: {
  prefix: string;
  start: number;
  count: number;
  padding: number;
}): string[] {
  return Array.from(
    { length: input.count },
    (_, i) => `${input.prefix}${String(input.start + i).padStart(input.padding, '0')}`,
  );
}

export interface BulkCreateUnitsResultDto {
  created: number;
  /** Ya existían y se han saltado. */
  skipped: string[];
  /** No caben en el plan: no se han creado. */
  overLimit: string[];
  /** Fallaron por otro motivo (el alta se para ahí). */
  failed: { code: string; error: string }[];
}

// ============================================================================
// Documentos del local
// ============================================================================

export const FacilityDocumentKindEnum = z.enum([
  'licence',
  'insurance',
  'lease',
  'inspection',
  'other',
]);
export type FacilityDocumentKind = z.infer<typeof FacilityDocumentKindEnum>;

export const FACILITY_DOCUMENT_KIND_LABELS: Record<FacilityDocumentKind, string> = {
  licence: 'Licencia o permiso',
  insurance: 'Seguro',
  lease: 'Contrato de la nave',
  inspection: 'Inspección / certificado',
  other: 'Otro',
};

export const FACILITY_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const RequestFacilityDocumentUploadSchema = z.object({
  mimeType: z.enum(FACILITY_DOCUMENT_MIME_TYPES),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024, 'Máximo 20 MB'),
});
export type RequestFacilityDocumentUploadInput = z.infer<
  typeof RequestFacilityDocumentUploadSchema
>;

export const CreateFacilityDocumentSchema = z.object({
  key: z.string().min(1).max(500),
  kind: FacilityDocumentKindEnum,
  name: z.string().trim().min(1).max(200),
  mimeType: z.enum(FACILITY_DOCUMENT_MIME_TYPES),
  sizeBytes: z.number().int().positive(),
  expiresOn: isoDay.optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type CreateFacilityDocumentInput = z.infer<typeof CreateFacilityDocumentSchema>;

export const UpdateFacilityDocumentSchema = z.object({
  kind: FacilityDocumentKindEnum.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  /** `null` quita la caducidad. */
  expiresOn: isoDay.nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type UpdateFacilityDocumentInput = z.infer<typeof UpdateFacilityDocumentSchema>;
