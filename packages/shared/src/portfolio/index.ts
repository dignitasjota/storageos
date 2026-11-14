import { z } from 'zod';

/**
 * Cartera: renovaciones, cambios de cuota previstos e historial de la cuota de
 * cada contrato.
 */

/** Ventana de la bandeja de renovaciones. */
export const RenewalWindowEnum = z.enum(['30', '60', '90', 'overdue']);
export type RenewalWindow = z.infer<typeof RenewalWindowEnum>;

export type RenewalRiskLevel = 'high' | 'medium' | 'low';

/** Una fila de la bandeja de renovaciones. */
export interface RenewalRowDto {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  unitCode: string;
  facilityName: string;
  status: 'active' | 'ending';
  autoRenew: boolean;
  endDate: string;
  /** Cuota sin IVA y antes del descuento. */
  priceMonthly: number;
  discountAmount: number;
  /** Meses desde que empezó el contrato. */
  monthsAsCustomer: number;
  /** Lo que debe vencido. */
  debt: number;
  risk: RenewalRiskLevel;
  riskFactors: string[];
  /** Oferta de renovación enviada y aún sin firmar. */
  pendingOffer: { annexId: string; months: number; newPrice: number | null; sentAt: string } | null;
}

/** Oferta de renovación: el inquilino la firma como anexo y se aplica sola. */
export const RenewalOfferSchema = z.object({
  months: z.number().int().min(1).max(60),
  /** Cuota del nuevo periodo (sin IVA); vacío = la misma. */
  newPrice: z.number().positive().max(100_000).optional(),
  /** Texto que se añade al anexo. */
  note: z.string().trim().max(1000).optional(),
});
export type RenewalOfferInput = z.infer<typeof RenewalOfferSchema>;

/** Lo que hace un anexo al firmarse. */
export interface RenewalAnnexAction {
  type: 'renewal';
  months: number;
  newPrice: number | null;
  /** Fin que tenía al enviar la oferta: si cambia, no se aplica sola. */
  expectedEndDate: string;
}

export type PriceChangeSource = 'scheduled' | 'rent_increase' | 'anniversary';

/** Un cambio de cuota previsto, venga de donde venga. */
export interface PriceChangeRowDto {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  unitCode: string;
  facilityName: string;
  currentPrice: number;
  newPrice: number;
  date: string;
  source: PriceChangeSource;
  /** Subida de una tanda: para quitarlo de ella. */
  rentIncreaseId: string | null;
  rentIncreaseName: string | null;
  rentIncreaseItemId: string | null;
  /** El inquilino ya está avisado. */
  notified: boolean;
}

export const PRICE_CHANGE_SOURCE_LABELS: Record<PriceChangeSource, string> = {
  scheduled: 'Cambio programado',
  rent_increase: 'Subida de precio',
  anniversary: 'Actualización anual (por revisar)',
};

/** Un cambio de la cuota de un contrato. */
export interface PriceHistoryEntryDto {
  date: string;
  from: number | null;
  to: number;
  reason: string | null;
  kind: 'start' | 'change' | 'scheduled';
}

export interface PriceHistoryDto {
  entries: PriceHistoryEntryDto[];
}

/** % propio de la actualización anual de un contrato (null = el del negocio). */
export const SetAnniversaryPctSchema = z.object({
  pct: z.number().min(-20).max(30).nullable(),
});
export type SetAnniversaryPctInput = z.infer<typeof SetAnniversaryPctSchema>;
