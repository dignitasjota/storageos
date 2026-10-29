import type { ContractPreOpeningDto } from '../contracts/pre-opening';
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
  /** SHA-256 del texto mostrado: se devuelve al firmar para detectar cambios. */
  termsHash: string;
  /** Fecha de la firma (si ya está firmado). */
  signedAt: string | null;
  /** Firmado y con la 1ª factura sin pagar: la página ofrece pagarla. */
  paymentPending: boolean;
  /** Reserva antes de la apertura del local (null si no lo es). */
  preOpening: ContractPreOpeningDto | null;
  /** Condiciones Generales de Contratación que debe aceptar antes de pagar. */
  generalTerms: GeneralTermsToAcceptDto;
}

/** Condiciones generales que el inquilino acepta con una casilla. */
export interface GeneralTermsToAcceptDto {
  title: string;
  /** Página pública de las condiciones (su web). */
  url: string;
  /** SHA-256 del texto vigente: se devuelve al aceptar. */
  hash: string;
  /** Ya las aceptó para este contrato. */
  accepted: boolean;
}

/** Aceptación de una versión de las condiciones (ficha del contrato). */
export interface LegalDocAcceptanceDto {
  id: string;
  versionId: string;
  version: number;
  title: string;
  contentHash: string;
  channel: string;
  ipAddress: string | null;
  userAgent: string | null;
  acceptedAt: string;
}

/** Una versión aceptada de un texto legal, con su texto completo. */
export interface LegalDocVersionDto {
  id: string;
  doc: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
  createdAt: string;
  /** Cuántas veces se ha aceptado. */
  acceptances: number;
  /** Es el texto que se publica ahora. */
  current: boolean;
}

/** Token de portal para pagar la 1ª factura de un contrato ya firmado. */
export interface SignPaymentSessionDto {
  portalToken: string;
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

/** Firma con su evidencia completa (ficha del contrato, pestaña Firma). */
export interface ContractSignatureDetailDto extends ContractSignatureDto {
  /** Data URL PNG de la firma dibujada, o null. */
  signatureImage: string | null;
  typedSignature: string | null;
  /** SHA-256 del texto firmado. */
  documentHash: string;
  userAgent: string | null;
  /** La huella coincide con el texto firmado guardado (null si no hay texto). */
  hashMatches: boolean | null;
}

/** Lo que firmó (o firmará) el inquilino y cómo. */
export interface ContractSigningRecordDto {
  status: string;
  signedAt: string | null;
  /** Texto firmado (congelado) o, en borrador, el que verá el inquilino. */
  termsText: string;
  /** true = texto congelado al firmar; false = vista previa del borrador. */
  termsFrozen: boolean;
  termsHash: string;
  signatures: ContractSignatureDetailDto[];
  /** Enlace de firma vigente (borrador con enlace enviado y sin caducar). */
  signingLinkActive: boolean;
  signingLinkExpiresAt: string | null;
  /** Reserva online: el trastero queda retenido hasta esta fecha si no se paga. */
  holdUntil: string | null;
  /** Condiciones generales aceptadas para este contrato (más reciente primero). */
  generalTerms: LegalDocAcceptanceDto[];
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
  /** El chat con IA de la web está activo (se ofrece ayuda en la reserva). */
  webChatEnabled: boolean;
  /** Dominio propio verificado (enlace a la privacidad del chat), o null. */
  customDomain: string | null;
  facilities: {
    id: string;
    name: string;
    /** Slug público del local (`/reservar/<slug>` en el dominio propio), o null. */
    publicSlug: string | null;
    /** Local en «próxima apertura»: reserva anticipada (primera mensualidad + fianza). */
    preOpening: boolean;
    /** Fecha de apertura prevista, o null si aún no está fijada. */
    openingDate: string | null;
    unitTypes: {
      id: string;
      name: string;
      available: number;
      /** Sin IVA: el del trastero más barato disponible de ese tamaño. */
      priceMonthly: number;
      /** % de IVA del alquiler (21; 0 en viviendas, exentas). */
      taxRate: number;
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
