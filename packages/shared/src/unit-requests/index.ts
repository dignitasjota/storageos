import { z } from 'zod';

import { FirstPaymentMonthsSchema } from '../coupons';

/** Solicitud de un trastero adicional desde el portal del inquilino. */
export const PortalUnitRequestSchema = z.object({
  /** Local de interés (opcional). */
  facilityId: z.string().uuid().optional(),
  /** Tipo de trastero deseado (opcional). */
  unitTypeId: z.string().uuid().optional(),
  /** Un trastero concreto que vio disponible (opcional). */
  unitId: z.string().uuid().optional(),
  note: z.string().trim().max(1000).optional(),
});
export type PortalUnitRequestInput = z.infer<typeof PortalUnitRequestSchema>;

/** Resolución de la solicitud por el staff. */
export const ResolveUnitRequestSchema = z.object({
  status: z.enum(['handled', 'rejected']),
  resolutionNote: z.string().trim().max(1000).optional(),
});
export type ResolveUnitRequestInput = z.infer<typeof ResolveUnitRequestSchema>;

export type UnitRequestStatus = 'pending' | 'handled' | 'rejected';

/** Un trastero disponible que el inquilino puede solicitar. */
export interface AvailableUnitDto {
  id: string;
  code: string;
  facilityId: string;
  facilityName: string;
  unitTypeId: string | null;
  unitTypeName: string | null;
  areaM2: number | null;
  /** Precio mensual de catálogo (del tipo), si está definido. */
  priceMonthly: number | null;
  /** IVA del alquiler (21 % trastero, 0 % vivienda). */
  taxRate: number;
  /** Oferta activa de este trastero (meses gratis), si la hay. */
  offer: { code: string; freeMonths: number; validUntil: string } | null;
}

/** Vista del inquilino (portal). */
export interface PortalUnitRequestDto {
  id: string;
  facilityName: string | null;
  unitTypeName: string | null;
  unitCode: string | null;
  note: string;
  status: UnitRequestStatus;
  resolutionNote: string | null;
  createdAt: string;
}

/** Vista del staff. */
export interface UnitRequestDto {
  id: string;
  customerId: string;
  customerName: string;
  facilityId: string | null;
  facilityName: string | null;
  unitTypeId: string | null;
  unitTypeName: string | null;
  unitId: string | null;
  unitCode: string | null;
  note: string;
  status: UnitRequestStatus;
  resolutionNote: string | null;
  createdAt: string;
  handledAt: string | null;
}

/** Self-service: contratar un trastero disponible desde el portal (con pago online). */
export const PortalBookUnitSchema = z.object({
  unitId: z.string().uuid(),
  /**
   * Obsoleto: la firma se hace después, en la página del contrato (`/sign`),
   * leyendo las condiciones. Se acepta para no romper clientes antiguos.
   */
  signerName: z.string().trim().max(120).optional(),
  /** Meses que se pagan ahora (1, 3, 6 o 12); después, mensual. */
  months: FirstPaymentMonthsSchema.default(1),
  /** Cupón de descuento sobre el pago de ahora. */
  couponCode: z.string().trim().toUpperCase().max(40).optional().or(z.literal('')),
});
export type PortalBookUnitInput = z.infer<typeof PortalBookUnitSchema>;

export interface PortalBookUnitResultDto {
  contractId: string;
  /** Enlace de firma: el inquilino lee el contrato, lo firma y paga (`/sign/<token>`). */
  signingToken: string;
  /** La primera factura se emite al firmar: aquí siempre null. */
  invoiceId: string | null;
  /** Token de portal renovado (para pagar sin re-loguear). */
  portalToken: string;
}
