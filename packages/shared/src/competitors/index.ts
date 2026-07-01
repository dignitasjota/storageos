import { z } from 'zod';

export const CompetitorUnitStatusEnum = z.enum(['available', 'occupied']);
export type CompetitorUnitStatus = z.infer<typeof CompetitorUnitStatusEnum>;

// --- Local de la competencia ---
export const CreateCompetitorFacilitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  zone: z.string().trim().max(120).optional().or(z.literal('')),
  /** Mi local con el que compite (opcional). */
  facilityId: z.string().uuid().nullable().optional(),
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
  notes: string | null;
  unitCount: number;
  availableCount: number;
  createdAt: string;
}

// --- Trastero de la competencia ---
export const CreateCompetitorUnitSchema = z.object({
  areaM2: z.number().positive().max(100000),
  priceMonthly: z.number().nonnegative().max(1000000),
  status: CompetitorUnitStatusEnum.default('available'),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
});
export type CreateCompetitorUnitInput = z.infer<typeof CreateCompetitorUnitSchema>;

export const UpdateCompetitorUnitSchema = CreateCompetitorUnitSchema.partial();
export type UpdateCompetitorUnitInput = z.infer<typeof UpdateCompetitorUnitSchema>;

export interface CompetitorUnitDto {
  id: string;
  competitorFacilityId: string;
  areaM2: number;
  priceMonthly: number;
  status: CompetitorUnitStatus;
  /** Cuándo se comprobó por última vez (= al introducir/actualizar el precio). */
  lastCheckedAt: string;
  notes: string | null;
}
