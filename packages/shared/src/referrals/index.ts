import { z } from 'zod';

import { PromotionDiscountTypeEnum } from '../billing/schemas';

export const ReferralStatusEnum = z.enum(['pending', 'converted', 'cancelled']);
export type ReferralStatusValue = z.infer<typeof ReferralStatusEnum>;

/**
 * Config del programa de referidos por tenant. La recompensa al referidor solo
 * admite `percentage`/`fixed` (un `free_months` no se puede convertir en una
 * promoción de un solo uso aplicable hoy).
 */
export const UpdateTenantReferralSettingsSchema = z.object({
  referralEnabled: z.boolean(),
  referralRewardType: PromotionDiscountTypeEnum.refine((t) => t !== 'free_months', {
    message: 'La recompensa debe ser porcentaje o importe fijo',
  }),
  referralRewardValue: z.number().nonnegative().max(1_000_000),
});
export type UpdateTenantReferralSettingsInput = z.infer<typeof UpdateTenantReferralSettingsSchema>;

export interface TenantReferralSettingsResponse {
  referralEnabled: boolean;
  referralRewardType: z.infer<typeof PromotionDiscountTypeEnum>;
  referralRewardValue: number;
}

/** Fila de la lista de referidos en el panel de staff. */
export interface ReferralDto {
  id: string;
  referrerCustomerId: string;
  referrerName: string;
  referredCustomerId: string;
  referredName: string;
  status: ReferralStatusValue;
  /** Código de la promoción-recompensa generada al convertir (si aplica). */
  /** Código de promoción (solo recompensas antiguas). */
  rewardCode: string | null;
  reward: ReferralRewardDto | null;
  createdAt: string;
  convertedAt: string | null;
}

export interface ReferralStatsDto {
  total: number;
  pending: number;
  converted: number;
}

/** Vista del portal del inquilino: su código + sus referidos + recompensas. */
export interface PortalReferralDto {
  enabled: boolean;
  referralCode: string | null;
  referrals: Array<{
    referredName: string;
    status: ReferralStatusValue;
    createdAt: string;
  }>;
  /**
   * Recompensas ganadas: descuento en la siguiente factura (aplicado o pendiente).
   * `code` solo en las antiguas, que eran códigos de promoción.
   */
  rewards: Array<ReferralRewardDto & { code: string | null }>;
}

/** Recompensa de un referido: descuento en la siguiente factura de quien recomienda. */
export interface ReferralRewardDto {
  type: 'percentage' | 'fixed';
  value: number;
  /** Cuándo se aplicó (null = pendiente de la próxima factura). */
  appliedAt: string | null;
  invoiceNumber: string | null;
}
