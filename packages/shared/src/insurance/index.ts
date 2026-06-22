import { z } from 'zod';

export const CreateInsurancePlanSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /** Prima mensual que se factura como línea recurrente. */
  monthlyPrice: z.number().nonnegative().max(100_000),
  /** Cobertura máxima (€) que se comunica al cliente. */
  coverageAmount: z.number().nonnegative().max(100_000_000).default(0),
  /** IVA aplicado a la prima (default 21%). */
  taxRate: z.number().min(0).max(100).default(21),
  description: z.string().trim().max(2_000).optional().or(z.literal('')),
  isActive: z.boolean().default(true),
});
export type CreateInsurancePlanInput = z.infer<typeof CreateInsurancePlanSchema>;

export const UpdateInsurancePlanSchema = CreateInsurancePlanSchema.partial();
export type UpdateInsurancePlanInput = z.infer<typeof UpdateInsurancePlanSchema>;

/** Asigna (o quita, con `planId: null`) un plan de seguro a un contrato. */
export const AssignInsuranceSchema = z.object({
  planId: z.string().uuid().nullable(),
});
export type AssignInsuranceInput = z.infer<typeof AssignInsuranceSchema>;

export interface InsurancePlanDto {
  id: string;
  name: string;
  monthlyPrice: number;
  coverageAmount: number;
  taxRate: number;
  description: string | null;
  isActive: boolean;
  createdAt: string;
}
