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
  depositAmount: optionalMoney,
  setupFee: optionalMoney,
  mandatoryInsuranceMonthly: optionalMoney,
  features: z.array(CompetitorFeatureEnum).max(10).optional(),
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
  depositAmount: number | null;
  setupFee: number | null;
  mandatoryInsuranceMonthly: number | null;
  features: CompetitorFeature[];
  /** Última revisión completa de sus trasteros (botón «Revisar»). */
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
    priceMonthly: z.number().nonnegative().max(1000000),
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
  priceMonthly: z.number().nonnegative().max(1000000).optional(),
  status: CompetitorUnitStatusEnum.optional(),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  externalRef: z.string().trim().max(60).optional().or(z.literal('')),
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
        priceMonthly: z.number().nonnegative().max(1000000),
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
   * 0-1. Solo es fiable con el inventario completo o un total conocido; si no,
   * null (no se sabe cuántos tiene en total).
   */
  occupancyPct: number | null;
  inventoryComplete: boolean;
  knownTotalUnits: number | null;
}

export interface MarketOccupancyDto {
  /** Mi ocupación física (trasteros ocupados / total activos), 0-1. */
  myOccupancyPct: number;
  myOccupiedUnits: number;
  myTotalUnits: number;
  /** Ocupación media de la competencia (ponderada por nº de trasteros), 0-1. */
  competitionOccupancyPct: number | null;
  competitionOccupiedUnits: number;
  competitionTotalUnits: number;
  competitors: CompetitorOccupancyRowDto[];
}
