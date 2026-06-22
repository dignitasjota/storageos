import { z } from 'zod';

export const RentIncreaseStatusEnum = z.enum(['scheduled', 'applied', 'cancelled']);
export type RentIncreaseStatusValue = z.infer<typeof RentIncreaseStatusEnum>;

export const RentIncreaseTypeEnum = z.enum(['percentage', 'fixed']);
export type RentIncreaseTypeValue = z.infer<typeof RentIncreaseTypeEnum>;

/** Filtros de los contratos a los que se les sube el precio. */
export const RentIncreaseScopeSchema = z.object({
  /** Antigüedad mínima del contrato (meses desde la firma). 0 = sin filtro. */
  minMonthsSinceSigned: z.number().int().min(0).max(120).default(0),
  /** Limitar a un local. */
  facilityId: z.string().uuid().optional(),
  /** Limitar a un tipo de trastero. */
  unitTypeId: z.string().uuid().optional(),
});
export type RentIncreaseScopeInput = z.infer<typeof RentIncreaseScopeSchema>;

const baseFields = {
  increaseType: RentIncreaseTypeEnum,
  /** % (p. ej. 8 = +8%) o € fijo según `increaseType`. */
  increaseValue: z.number().positive().max(100_000),
  scope: RentIncreaseScopeSchema,
};

/** Previsualiza los contratos afectados y el delta de MRR sin persistir. */
export const PreviewRentIncreaseSchema = z.object(baseFields);
export type PreviewRentIncreaseInput = z.infer<typeof PreviewRentIncreaseSchema>;

export const CreateRentIncreaseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  ...baseFields,
  /** Fecha efectiva (YYYY-MM-DD): el cron aplica la subida ese día. */
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)'),
});
export type CreateRentIncreaseInput = z.infer<typeof CreateRentIncreaseSchema>;

export interface RentIncreaseAffectedContract {
  contractId: string;
  contractNumber: string;
  customerName: string;
  unitCode: string;
  oldPrice: number;
  newPrice: number;
}

export interface RentIncreasePreviewDto {
  affectedCount: number;
  /** Suma mensual de (nuevo − antiguo). */
  mrrDelta: number;
  contracts: RentIncreaseAffectedContract[];
}

export interface RentIncreaseItemDto {
  id: string;
  contractId: string;
  contractNumber: string;
  customerName: string;
  unitCode: string;
  oldPrice: number;
  newPrice: number;
  status: 'pending' | 'applied' | 'skipped';
  skipReason: string | null;
  appliedAt: string | null;
}

export interface RentIncreaseDto {
  id: string;
  name: string;
  scope: RentIncreaseScopeInput;
  increaseType: RentIncreaseTypeValue;
  increaseValue: number;
  effectiveDate: string;
  status: RentIncreaseStatusValue;
  affectedCount: number;
  appliedCount: number;
  mrrDelta: number;
  noticeSent: boolean;
  createdAt: string;
  appliedAt: string | null;
  /** Solo en el detalle. */
  items?: RentIncreaseItemDto[];
}
