import { z } from 'zod';

export type RetentionOfferStatus = 'pending' | 'accepted' | 'declined' | 'expired';

/** El staff crea una contraoferta de retención sobre un contrato en baja. */
export const CreateRetentionOfferSchema = z.object({
  discountType: z.enum(['percentage', 'fixed']),
  /** % (1-100) o € por mes según `discountType`. */
  discountValue: z.number().positive().max(100_000),
  /** Nº de meses que dura el descuento (informativo en v1). */
  months: z.number().int().min(1).max(24).default(1),
  message: z.string().trim().max(1000).optional(),
  /** Días de validez de la oferta (por defecto 7). */
  validDays: z.number().int().min(1).max(60).optional(),
});
export type CreateRetentionOfferInput = z.infer<typeof CreateRetentionOfferSchema>;

export interface RetentionOfferDto {
  id: string;
  contractId: string;
  customerId: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  months: number;
  message: string | null;
  status: RetentionOfferStatus;
  validUntil: string | null;
  respondedAt: string | null;
  createdAt: string;
}

/** Vista del inquilino en el portal (incluye la cuota estimada tras el descuento). */
export interface PortalRetentionOfferDto extends RetentionOfferDto {
  unitCode: string;
  currentPriceMonthly: number;
  discountedPriceMonthly: number;
}
