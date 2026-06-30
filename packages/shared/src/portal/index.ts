import { z } from 'zod';

import type { ContractDepositStatusValue, ContractStatusValue } from '../customers/schemas';

/** Contrato tal como lo ve el inquilino en su portal. */
export interface PortalContractDto {
  id: string;
  contractNumber: string;
  unitCode: string;
  facilityName: string;
  status: ContractStatusValue;
  startDate: string;
  endDate: string | null;
  priceMonthly: number;
  effectivePrice: number;
  cancellationNoticeDays: number;
  endingRequestedAt: string | null;
  /** Fianza/depósito y su estado. */
  depositAmount: number;
  depositStatus: ContractDepositStatusValue;
  /** Descuento recurrente (€) y meses gratis pendientes (promoción). */
  discountAmount: number;
  freeMonthsRemaining: number;
  /** Seguro/protección de contenido contratado (null si no tiene). */
  insurancePlanId: string | null;
  insurancePlanName: string | null;
  insurancePrice: number | null;
  /** true si hay PDF del contrato firmado disponible para descargar. */
  hasSignedPdf: boolean;
}

/** Un pago del inquilino, visto en su portal (historial de cobros). */
export interface PortalPaymentDto {
  id: string;
  amount: number;
  currency: string;
  status: string;
  methodType: string;
  /** Cuándo se cobró (ISO); null si aún no liquidado. */
  paidAt: string | null;
  /** Nº de factura asociada (si la hay). */
  invoiceNumber: string | null;
  createdAt: string;
}

/** Datos del local donde el inquilino tiene un trastero. */
export interface PortalFacilityDto {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /** Toque de queda de acceso (HH:MM), si está activo. */
  accessCurfewEnabled: boolean;
  accessCurfewStart: string | null;
  accessCurfewEnd: string | null;
}

/** URL temporal para descargar un documento (p. ej. el contrato firmado). */
export interface PortalDownloadDto {
  url: string;
}

/** Datos de perfil del inquilino que él mismo puede ver/editar en el portal. */
export interface PortalProfileDto {
  customerType: 'individual' | 'business';
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  /** Solo lectura: el email es el identificador de acceso (lo cambia el staff). */
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  documentType: string | null;
  documentNumber: string | null;
}

const optionalProfileText = (max: number) => z.string().trim().max(max).optional();

/**
 * Edición del propio perfil desde el portal. Campos opcionales: un campo
 * presente con cadena vacía se interpreta como "borrar". El email NO se puede
 * cambiar aquí (identificador de login).
 */
export const PortalUpdateProfileSchema = z.object({
  firstName: optionalProfileText(120),
  lastName: optionalProfileText(120),
  companyName: optionalProfileText(200),
  phone: optionalProfileText(40),
  address: optionalProfileText(200),
  city: optionalProfileText(120),
  postalCode: optionalProfileText(20),
  country: z.string().trim().length(2).optional(),
  documentType: optionalProfileText(30),
  documentNumber: optionalProfileText(60),
});
export type PortalUpdateProfileInput = z.infer<typeof PortalUpdateProfileSchema>;

/** Compra de accesorios desde el portal: líneas {producto, cantidad}. */
export const PortalPurchaseSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive().max(99),
      }),
    )
    .min(1),
});
export type PortalPurchaseInput = z.infer<typeof PortalPurchaseSchema>;

/** El inquilino contrata (planId) o quita (null) el seguro en uno de sus contratos. */
export const PortalSetInsuranceSchema = z.object({
  planId: z.string().uuid().nullable(),
});
export type PortalSetInsuranceInput = z.infer<typeof PortalSetInsuranceSchema>;

/** Solicitud de baja (move-out) desde el portal. */
export const RequestMoveOutSchema = z.object({
  /** Fecha de salida deseada (YYYY-MM-DD); debe respetar el preaviso. */
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD'),
});
export type RequestMoveOutInput = z.infer<typeof RequestMoveOutSchema>;

/** Incidencia reportada por el inquilino desde el portal. */
export const PortalReportIncidentSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).optional(),
});
export type PortalReportIncidentInput = z.infer<typeof PortalReportIncidentSchema>;

export interface PortalIncidentDto {
  id: string;
  title: string;
  description: string | null;
  status: string;
  severity: string;
  createdAt: string;
}

/** Acceso adicional que el inquilino se crea desde el portal (familiar, etc.). */
export const PortalCreateExtraAccessSchema = z.object({
  label: z.string().trim().min(1).max(60),
});
export type PortalCreateExtraAccessInput = z.infer<typeof PortalCreateExtraAccessSchema>;

/** Disponibilidad + precio del pase nocturno (para la card del portal). */
export interface PortalNightPassInfoDto {
  enabled: boolean;
  /** Precio del pase (sin IVA; la factura añade el 21%). */
  price: number;
}
