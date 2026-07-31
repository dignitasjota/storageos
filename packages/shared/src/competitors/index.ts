import { z } from 'zod';

export const CompetitorUnitStatusEnum = z.enum(['available', 'occupied']);
export type CompetitorUnitStatus = z.infer<typeof CompetitorUnitStatusEnum>;

// --- Local de la competencia ---
export const CreateCompetitorFacilitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  zone: z.string().trim().max(120).optional().or(z.literal('')),
  /** Mi local con el que compite (opcional). */
  facilityId: z.string().uuid().nullable().optional(),
  /** ¿Los precios de sus trasteros incluyen IVA? (para normalizar a neto al comparar). */
  priceIncludesVat: z.boolean().default(true),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
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
  /** Cuándo se comprobó por última vez (= al introducir/actualizar el precio). */
  lastCheckedAt: string;
  notes: string | null;
}

// --- Ocupación de mercado: mi ocupación vs la de la competencia ---
export interface CompetitorOccupancyRowDto {
  id: string;
  name: string;
  unitCount: number;
  occupiedCount: number;
  /** 0-1; null si el competidor no tiene trasteros fichados. */
  occupancyPct: number | null;
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
