import { z } from 'zod';

/** PUT /billing/verifactu/settings — activar o desactivar el envío a la AEAT. */
export const UpdateVerifactuSettingsSchema = z.object({ enabled: z.boolean() });
export type UpdateVerifactuSettingsInput = z.infer<typeof UpdateVerifactuSettingsSchema>;

/**
 * Desde cuándo es obligatorio (RD 1007/2023, plazos del Real Decreto-ley
 * 15/2025): quien paga el Impuesto sobre Sociedades y el resto (autónomos,
 * comunidades de bienes…). Si se vuelve a aplazar, se cambia aquí.
 */
export const VERIFACTU_MANDATORY_FROM = {
  companies: '2027-01-01',
  others: '2027-07-01',
} as const;

/** Lo que impide activar Veri*Factu ahora (el código es el error que daría). */
export interface VerifactuBlockerDto {
  code:
    | 'verifactu_platform_not_ready'
    | 'issuer_fiscal_data_required'
    | 'tenant_tax_id_required'
    | 'aeat_certificate_required';
  message: string;
  /** Dónde se arregla (null: en la propia página de Veri*Factu). */
  href: string | null;
}

/**
 * Un envío a la AEAT: hasta 1.000 registros de un mismo emisor (el negocio o
 * uno de sus propietarios), con el CSV que acredita la remisión.
 */
export interface VerifactuSubmissionDto {
  id: string;
  sentAt: string;
  /** El propietario que emite (plan Administrador); null = el propio negocio. */
  ownerName: string | null;
  /**
   * `accepted`: todos registrados · `partially_accepted`: alguno rechazado ·
   * `rejected`: ninguno · `error`: sin respuesta válida de la AEAT (se repite).
   */
  status: 'accepted' | 'partially_accepted' | 'rejected' | 'error';
  /** Código seguro de verificación del envío (no hay si se rechazó entero). */
  csv: string | null;
  recordCount: number;
  acceptedCount: number;
  rejectedCount: number;
  /** Segundos que la AEAT pidió esperar antes del siguiente envío. */
  waitSeconds: number | null;
  message: string | null;
  mode: 'stub' | 'sandbox' | 'production';
}

/** GET /billing/verifactu/settings */
export interface VerifactuSettingsDto {
  enabled: boolean;
  enabledAt: string | null;
  /** Activado, no se puede apagar antes de esta fecha (AAAA-MM-DD, art. 17). */
  lockedUntil: string | null;
  /** Cómo envía la plataforma: con `stub` no llega nada a la AEAT (simulado). */
  platformMode: 'stub' | 'sandbox' | 'production';
  /** Lo que falta para poder activarlo (vacío = se puede). */
  blockers: VerifactuBlockerDto[];
  /** Facturas con Veri*Factu que aún no constan registradas (en cola o con error). */
  pendingCount: number;
  /** Facturas con Veri*Factu que la AEAT rechazó. */
  rejectedCount: number;
  /** Emite en Holded: Holded registra esas facturas en la AEAT. */
  invoicingInHolded: boolean;
  /** El último envío a la AEAT (de cualquiera de tus emisores). */
  lastSubmission: VerifactuSubmissionDto | null;
  /**
   * Con facturas por enviar, cuándo sale el siguiente envío: la AEAT pide
   * esperar entre uno y otro, o tras un fallo se reintenta más tarde. Null si
   * no hay nada pendiente o sale ya.
   */
  nextSendAt: string | null;
}

/**
 * El sistema informático de facturación tal como lo declara su fabricante.
 * Va en el bloque `SistemaInformatico` de cada registro que se envía a la AEAT
 * y en la declaración responsable (art. 15 de la Orden HAC/1177/2024): tienen
 * que coincidir. La versión cambia cuando cambia la parte de facturación, y
 * cada versión lleva su declaración.
 */
export const VERIFACTU_SYSTEM = {
  producerName: 'Urbanbox Soluciones SL',
  producerTaxId: 'B05691886',
  name: 'TrasterOS',
  /** Código de 2 caracteres que el fabricante da a su sistema. */
  id: '01',
  version: '1.0',
} as const;

/** Texto que va encima del QR en la factura (especificación del QR de la AEAT, apdo. 3). */
export const VERIFACTU_QR_LABEL = 'QR tributario:';

/** Frase que va justo debajo del QR en las facturas de un sistema VERI*FACTU (art. 20.1.b). */
export const VERIFACTU_INVOICE_LEGEND = 'Factura verificable en la sede electrónica de la AEAT';
