import type { FirstPaymentQuoteDto } from '../coupons';

/** Vista pública de un contrato a punto de firmarse (página /sign/[token]). */
export interface ContractSignViewDto {
  contractNumber: string;
  customerName: string;
  unitCode: string;
  facilityName: string;
  priceMonthly: number;
  depositAmount: number;
  /** `cash`: la fianza se paga en el local, no en el pago online. */
  depositPaymentMethod: 'online' | 'cash';
  billingCycle: string;
  startDate: string;
  /** Texto de términos a aceptar (resumen legible). */
  termsText: string;
  /** true si ya está firmado (la página muestra estado, no formulario). */
  alreadySigned: boolean;
  /** Marca del operador (white-label) para el marco de la página de firma. */
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  /** Measurement ID de Google Analytics 4 (`G-XXXXXXXXXX`), o null. */
  googleAnalyticsId: string | null;
  /** Lo que se paga al activar (meses del primer pago, cupón, IVA y fianza). */
  firstPayment: FirstPaymentQuoteDto;
}

/** Resultado de firmar: estado + token de portal para pagar la 1ª factura. */
export interface SignResultDto {
  contractId: string;
  status: string;
  /** Token de sesión de portal (para pagar sin login adicional), si procede. */
  portalToken: string | null;
}

/** Registro probatorio de firma (vista staff). */
export interface ContractSignatureDto {
  id: string;
  signerName: string;
  signerEmail: string | null;
  method: string;
  channel: string;
  ipAddress: string | null;
  signedAt: string;
}

/** Resultado de solicitar la firma (staff): enlace para compartir. */
export interface RequestSignatureResultDto {
  signingUrl: string;
  expiresAt: string;
  emailed: boolean;
}

/** Disponibilidad pública por local/tipo para el move-in. */
export interface BookingAvailabilityDto {
  tenantName: string;
  /** Slug del tenant (para el enlace de portal del marco white-label). */
  tenantSlug: string;
  /** Marca del operador (white-label): color hex y logo, o null. */
  brandColor: string | null;
  logoUrl: string | null;
  /** Measurement ID de Google Analytics 4 (`G-XXXXXXXXXX`), o null. */
  googleAnalyticsId: string | null;
  facilities: {
    id: string;
    name: string;
    /** Slug público del local (`/reservar/<slug>` en el dominio propio), o null. */
    publicSlug: string | null;
    unitTypes: {
      id: string;
      name: string;
      available: number;
      priceMonthly: number;
    }[];
  }[];
}

/** Resultado del alta self-service: a dónde ir a firmar. */
export interface BookingResultDto {
  contractId: string;
  /**
   * Enlace de firma para seguir en esta misma pantalla. `null` cuando el email
   * ya es de un inquilino: el enlace se envía a ese email (solo sigue quien
   * tiene acceso a ese buzón) y `signingLinkSentTo` dice a dónde.
   */
  signingToken: string | null;
  /** Email (enmascarado) al que se envió el enlace, o null. */
  signingLinkSentTo: string | null;
}
