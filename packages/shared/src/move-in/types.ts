/** Vista pública de un contrato a punto de firmarse (página /sign/[token]). */
export interface ContractSignViewDto {
  contractNumber: string;
  customerName: string;
  unitCode: string;
  facilityName: string;
  priceMonthly: number;
  depositAmount: number;
  billingCycle: string;
  startDate: string;
  /** Texto de términos a aceptar (resumen legible). */
  termsText: string;
  /** true si ya está firmado (la página muestra estado, no formulario). */
  alreadySigned: boolean;
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
  facilities: {
    id: string;
    name: string;
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
  signingToken: string;
}
