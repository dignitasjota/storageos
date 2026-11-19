import { z } from 'zod';

export const CompetitorUnitStatusEnum = z.enum(['available', 'occupied']);
export type CompetitorUnitStatus = z.infer<typeof CompetitorUnitStatusEnum>;

/** Cómo se consultó al competidor (para repetirlo la próxima vez). */
export const CompetitorContactMethodEnum = z.enum([
  'phone',
  'web',
  'visit',
  'email',
  'whatsapp',
  'other',
]);
export type CompetitorContactMethod = z.infer<typeof CompetitorContactMethodEnum>;
export const COMPETITOR_CONTACT_METHOD_LABELS: Record<CompetitorContactMethod, string> = {
  phone: 'Por teléfono',
  web: 'En su web',
  visit: 'Visita al local',
  email: 'Por email',
  whatsapp: 'Por WhatsApp',
  other: 'Otro',
};

/** Características que influyen en el precio. */
export const CompetitorFeatureEnum = z.enum([
  '24h',
  'climate',
  'vehicle_access',
  'cctv',
  'ground_floor',
  'online_booking',
]);
export type CompetitorFeature = z.infer<typeof CompetitorFeatureEnum>;
export const COMPETITOR_FEATURE_LABELS: Record<CompetitorFeature, string> = {
  '24h': 'Acceso 24 h',
  climate: 'Climatizado',
  vehicle_access: 'Acceso con vehículo',
  cctv: 'Videovigilancia',
  ground_floor: 'Planta baja',
  online_booking: 'Reserva online',
};

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));
const optionalMoney = z.number().nonnegative().max(100000).nullable().optional();

// --- Local de la competencia ---
export const CreateCompetitorFacilitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  zone: z.string().trim().max(120).optional().or(z.literal('')),
  /** Mi local con el que compite (opcional). */
  facilityId: z.string().uuid().nullable().optional(),
  /** ¿Los precios de sus trasteros incluyen IVA? (para normalizar a neto al comparar). */
  priceIncludesVat: z.boolean().default(true),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  phone: optionalText(40),
  website: optionalText(300),
  address: optionalText(300),
  contactMethod: CompetitorContactMethodEnum.nullable().optional(),
  /** Detalle de cómo consultarlo: persona, página de disponibilidad, horario… */
  contactNotes: optionalText(1000),
  distanceKm: z.number().nonnegative().max(1000).nullable().optional(),
  /** Todos sus trasteros están fichados: su ocupación es fiable. */
  inventoryComplete: z.boolean().optional(),
  /** Total de trasteros que se sabe que tiene (aunque no estén todos fichados). */
  knownTotalUnits: z.number().int().positive().max(100000).nullable().optional(),
  currentPromotion: optionalText(300),
  /** Promoción como dato, para el precio comparable. */
  promoFreeMonths: z.number().int().min(0).max(12).nullable().optional(),
  promoDiscountPct: z.number().int().min(0).max(100).nullable().optional(),
  promoDiscountMonths: z.number().int().min(0).max(12).nullable().optional(),
  depositAmount: optionalMoney,
  setupFee: optionalMoney,
  mandatoryInsuranceMonthly: optionalMoney,
  features: z.array(CompetitorFeatureEnum).max(10).optional(),
  /** Cada cuántos días conviene revisarlo (vacío = 30). */
  reviewEveryDays: z.number().int().min(1).max(365).nullable().optional(),
  /** Hasta cuándo dura su promoción (AAAA-MM-DD); después no cuenta. */
  promoEndsAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida')
    .nullable()
    .optional(),
});
export type CreateCompetitorFacilityInput = z.infer<typeof CreateCompetitorFacilitySchema>;

export const UpdateCompetitorFacilitySchema = CreateCompetitorFacilitySchema.partial();
export type UpdateCompetitorFacilityInput = z.infer<typeof UpdateCompetitorFacilitySchema>;

export interface CompetitorFacilityDto {
  id: string;
  name: string;
  zone: string | null;
  facilityId: string | null;
  /** Nombre de mi local relacionado, si lo hay. */
  facilityName: string | null;
  /** ¿Los precios de sus trasteros incluyen IVA? */
  priceIncludesVat: boolean;
  notes: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  contactMethod: CompetitorContactMethod | null;
  contactNotes: string | null;
  distanceKm: number | null;
  inventoryComplete: boolean;
  inventoryCompletedAt: string | null;
  knownTotalUnits: number | null;
  currentPromotion: string | null;
  promoFreeMonths: number | null;
  promoDiscountPct: number | null;
  promoDiscountMonths: number | null;
  depositAmount: number | null;
  setupFee: number | null;
  mandatoryInsuranceMonthly: number | null;
  features: CompetitorFeature[];
  reviewEveryDays: number | null;
  promoEndsAt: string | null;
  /** La promoción cuenta hoy (tiene datos y no ha terminado). */
  promotionActive: boolean;
  /** Cuándo toca revisarlo (la última comprobación + su plazo). */
  nextReviewOn: string | null;
  /**
   * Última vez que se comprobó algo suyo: la revisión completa o cualquier
   * trastero (alta, cambio de precio o de estado, «lo he comprobado hoy»).
   */
  lastReviewedAt: string | null;
  unitCount: number;
  availableCount: number;
  createdAt: string;
}

// --- Trastero de la competencia ---
// El área puede darse directa (`areaM2`) o derivarse de las medidas: si se
// indican ancho y fondo, el servidor calcula el área. Las medidas son opcionales
// («cuando se dispone de esa información»); la altura es informativa (volumen).
export const CreateCompetitorUnitSchema = z
  .object({
    areaM2: z.number().positive().max(100000).optional(),
    widthM: z.number().positive().max(1000).optional(),
    depthM: z.number().positive().max(1000).optional(),
    heightM: z.number().positive().max(1000).optional(),
    priceMonthly: z.number().positive('El precio tiene que ser mayor que 0').max(1000000),
    status: CompetitorUnitStatusEnum.default('available'),
    notes: z.string().trim().max(500).optional().or(z.literal('')),
    externalRef: z.string().trim().max(60).optional().or(z.literal('')),
  })
  .refine((v) => v.areaM2 != null || (v.widthM != null && v.depthM != null), {
    message: 'Indica el área (m²) o bien el ancho y el fondo',
    path: ['areaM2'],
  });
export type CreateCompetitorUnitInput = z.infer<typeof CreateCompetitorUnitSchema>;

// Partial para editar: no re-exige el refine (se puede actualizar solo el precio).
export const UpdateCompetitorUnitSchema = z.object({
  areaM2: z.number().positive().max(100000).optional(),
  widthM: z.number().positive().max(1000).nullable().optional(),
  depthM: z.number().positive().max(1000).nullable().optional(),
  heightM: z.number().positive().max(1000).nullable().optional(),
  priceMonthly: z.number().positive('El precio tiene que ser mayor que 0').max(1000000).optional(),
  status: CompetitorUnitStatusEnum.optional(),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  externalRef: z.string().trim().max(60).optional().or(z.literal('')),
  /** Se ha comprobado hoy (aunque no cambie): queda en su histórico. */
  checked: z.boolean().optional(),
});
export type UpdateCompetitorUnitInput = z.infer<typeof UpdateCompetitorUnitSchema>;

export interface CompetitorUnitDto {
  id: string;
  competitorFacilityId: string;
  areaM2: number;
  /** Medidas, si se conocen (null si no). */
  widthM: number | null;
  depthM: number | null;
  heightM: number | null;
  priceMonthly: number;
  status: CompetitorUnitStatus;
  /** Cuándo se comprobó por última vez. */
  lastCheckedAt: string;
  notes: string | null;
  externalRef: string | null;
  /** Resumen de su histórico de comprobaciones. */
  history: CompetitorUnitHistorySummaryDto;
  /**
   * Lo que paga de media un cliente al mes el primer año, sin IVA y con su
   * seguro obligatorio, alta y promoción: comparable con tu precio.
   */
  comparablePrice: number;
  /** Precio comparable por m². */
  comparablePerM2: number;
}

export interface CompetitorUnitHistorySummaryDto {
  observations: number;
  firstObservedAt: string | null;
  firstPrice: number | null;
  /** Variación del precio desde la primera comprobación (%), null sin datos. */
  priceChangePct: number | null;
  /** Desde cuándo está en su estado actual (primera comprobación con ese estado seguida). */
  inCurrentStatusSince: string | null;
  /** Veces que ha pasado de libre a ocupado (alquileres observados). */
  timesRented: number;
}

export interface CompetitorUnitObservationDto {
  id: string;
  observedAt: string;
  priceMonthly: number;
  status: CompetitorUnitStatus;
}

/** Revisión de un competidor: el estado y precio de hoy de cada trastero. */
export const ReviewCompetitorSchema = z.object({
  units: z
    .array(
      z.object({
        id: z.string().uuid(),
        priceMonthly: z.number().positive('El precio tiene que ser mayor que 0').max(1000000),
        status: CompetitorUnitStatusEnum,
      }),
    )
    .max(1000),
});
export type ReviewCompetitorInput = z.infer<typeof ReviewCompetitorSchema>;

// --- Ocupación de mercado: mi ocupación vs la de la competencia ---
export interface CompetitorOccupancyRowDto {
  id: string;
  name: string;
  unitCount: number;
  occupiedCount: number;
  /**
   * 0-1. Solo con el inventario completo y revisado en los últimos 180 días
   * (como en la sugerencia de precio); si no, null.
   */
  occupancyPct: number | null;
  /**
   * 0-1. Estimada con su total conocido (los no fichados se dan por ocupados):
   * se enseña aparte y no cuenta en la media del mercado.
   */
  estimatedOccupancyPct: number | null;
  inventoryComplete: boolean;
  knownTotalUnits: number | null;
  /** Hace más de 180 días que no se comprueba: no cuenta. */
  stale: boolean;
}

export interface MarketOccupancyDto {
  /** Local del filtro (null = todos los que ve el usuario). */
  facilityId: string | null;
  /** Mi ocupación física, la misma que en Analítica (sin locales por abrir), 0-1. */
  myOccupancyPct: number;
  myOccupiedUnits: number;
  myTotalUnits: number;
  /**
   * Ocupación media de la competencia con el inventario completo y reciente
   * (ponderada por nº de trasteros), 0-1.
   */
  competitionOccupancyPct: number | null;
  competitionOccupiedUnits: number;
  competitionTotalUnits: number;
  competitors: CompetitorOccupancyRowDto[];
}

// --- Mejoras (2026-11-19) ---

/** Alta de varios trasteros de una vez (pegados de una tabla). */
export const BulkCreateCompetitorUnitsSchema = z.object({
  units: z.array(CreateCompetitorUnitSchema).min(1).max(200),
});
export type BulkCreateCompetitorUnitsInput = z.infer<typeof BulkCreateCompetitorUnitsSchema>;

/** Texto de su página de tarifas para que la IA proponga sus trasteros. */
export const CompetitorAiParseSchema = z.object({
  text: z.string().trim().min(20, 'Pega el texto de su página de tarifas').max(20000),
});
export type CompetitorAiParseInput = z.infer<typeof CompetitorAiParseSchema>;

export interface CompetitorUnitProposalDto {
  areaM2: number | null;
  widthM: number | null;
  depthM: number | null;
  priceMonthly: number;
  status: CompetitorUnitStatus;
  externalRef: string | null;
  /** El trastero suyo que ya tienes fichado con esas medidas (para actualizarlo). */
  matchUnitId: string | null;
}

export interface CompetitorAiParseResultDto {
  units: CompetitorUnitProposalDto[];
  /** Lo que la IA ha visto que no son trasteros (promociones, fianza…). */
  notes: string | null;
}

export interface CompetitorPromotionDto {
  id: string;
  description: string | null;
  freeMonths: number | null;
  discountPct: number | null;
  discountMonths: number | null;
  endsAt: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** Tu precio frente al del mercado para cada tipo de trastero. */
export interface MarketPriceRowDto {
  unitTypeId: string;
  name: string;
  /** m² medios de tus trasteros de ese tipo. */
  areaM2: number;
  /** Tu precio medio de hoy, sin IVA. */
  myPrice: number;
  /** Precio comparable de la competencia en tamaños parecidos (±25 % de m²). */
  marketMedian: number | null;
  marketMin: number | null;
  marketMax: number | null;
  samples: number;
  /** Cuánto estás por encima (+) o por debajo (−) de la mediana, en %. */
  gapPct: number | null;
}

export interface MarketPricePointDto {
  source: 'mine' | 'competitor';
  name: string;
  areaM2: number;
  price: number;
}

export interface MarketPriceMapDto {
  facilityId: string | null;
  rows: MarketPriceRowDto[];
  points: MarketPricePointDto[];
}

/** Evolución mensual de un competidor. */
export interface CompetitorTrendDto {
  points: {
    yearMonth: string;
    /** Precio comparable medio de sus trasteros comprobados hasta ese mes. */
    avgComparablePrice: number | null;
    /** Ocupación al final del mes (solo con su inventario completo). */
    occupancy: number | null;
  }[];
}

/** Una fila por trastero de la competencia, para exportar. */
export interface CompetitorUnitExportRowDto {
  competitorName: string;
  zone: string | null;
  facilityName: string | null;
  distanceKm: number | null;
  areaM2: number;
  priceMonthly: number;
  priceIncludesVat: boolean;
  comparablePrice: number;
  status: CompetitorUnitStatus;
  externalRef: string | null;
  lastCheckedAt: string;
}
