import { z } from 'zod';

export const UpdateHoldedSettingsSchema = z.object({
  /** API key de Holded. Si se omite, no se cambia (se conserva la existente). */
  apiKey: z.string().trim().min(10).max(200).optional(),
  enabled: z.boolean(),
  /**
   * Series de Holded donde se copian las facturas y las rectificativas. Deben
   * estar marcadas «No enviar a Verifactu» (la app ya las registra en la AEAT).
   * Omitido = no se cambia; `null` = quitarla.
   */
  invoiceSeriesId: z.string().trim().min(1).max(100).nullable().optional(),
  creditNoteSeriesId: z.string().trim().min(1).max(100).nullable().optional(),
});
export type UpdateHoldedSettingsInput = z.infer<typeof UpdateHoldedSettingsSchema>;

export interface HoldedSettingsDto {
  enabled: boolean;
  /** true si hay una API key guardada (nunca se devuelve la key). */
  hasApiKey: boolean;
  invoiceSeriesId: string | null;
  creditNoteSeriesId: string | null;
  /** Activa, con clave y serie de facturas: lista para copiar facturas. */
  ready: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Elementos para revisar a mano en Holded (ver `HoldedReviewItemDto`). */
  reviewCount: number;
}

/**
 * Algo que conviene comprobar a mano en Holded:
 * - `invoice_unconfirmed`: se envió la factura y Holded no respondió (pudo crearse o no);
 * - `payment_unconfirmed`: lo mismo con un cobro;
 * - `payment_reversed`: un cobro ya copiado se devolvió o reembolsó después
 *   (Holded no permite quitarlo por API).
 */
export type HoldedReviewKind = 'invoice_unconfirmed' | 'payment_unconfirmed' | 'payment_reversed';

export interface HoldedReviewItemDto {
  kind: HoldedReviewKind;
  /** Id de la factura (`invoice_unconfirmed`) o del cobro. */
  id: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  amount: number;
  /** Cuándo se envió o se devolvió. */
  date: string;
  /** Estado actual del cobro (`payment_reversed`). */
  paymentStatus: string | null;
}

/**
 * Resolver un elemento para revisar:
 * - `retry`: no está en Holded → se vuelve a enviar;
 * - `already_in_holded`: sí está (factura: pegar su id de Holded);
 * - `reviewed`: cobro devuelto ya corregido a mano en Holded.
 */
export const ResolveHoldedReviewSchema = z.object({
  action: z.enum(['retry', 'already_in_holded', 'reviewed']),
  holdedDocumentId: z.string().trim().min(1).max(100).optional(),
});
export type ResolveHoldedReviewInput = z.infer<typeof ResolveHoldedReviewSchema>;

/** Serie de numeración de la cuenta de Holded del tenant. */
export interface HoldedSeriesDto {
  id: string;
  name: string;
  format: string;
  /** Marcada «No enviar a Verifactu»: es la única válida para la copia. */
  verifactuExcluded: boolean;
}

export interface HoldedSeriesListDto {
  invoice: HoldedSeriesDto[];
  creditnote: HoldedSeriesDto[];
}

export interface HoldedTestResultDto {
  ok: boolean;
  message: string;
}

/** Copia en Holded de las facturas de suscripción de la plataforma (super admin). */
export const UpdatePlatformHoldedSettingsSchema = z.object({
  /** API key de Holded. Omitida = se conserva la actual. */
  apiKey: z.string().trim().min(10).max(200).optional(),
  enabled: z.boolean(),
  /** Serie «No enviar a Verifactu». Omitido = no cambia; null = quitarla. */
  invoiceSeriesId: z.string().trim().min(1).max(100).nullable().optional(),
  /** Serie de rectificativas «No enviar a Verifactu». Omitido = no cambia; null = quitarla. */
  creditNoteSeriesId: z.string().trim().min(1).max(100).nullable().optional(),
});
export type UpdatePlatformHoldedSettingsInput = z.infer<typeof UpdatePlatformHoldedSettingsSchema>;

export interface PlatformHoldedSettingsDto {
  enabled: boolean;
  hasApiKey: boolean;
  invoiceSeriesId: string | null;
  creditNoteSeriesId: string | null;
  /** Activa, con clave y serie: las facturas de suscripción se copian a Holded. */
  ready: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Facturas de suscripción aún sin copiar a Holded. */
  pendingCount: number;
  /** Envíos sin confirmar (Holded no respondió): hay que comprobarlos en Holded. */
  reviewCount: number;
}

/** Factura de suscripción cuyo envío a Holded quedó sin confirmar. */
export interface PlatformHoldedReviewItemDto {
  /** `invoice`: la factura (o la sustitutiva); `credit_note`: la anulación de la original; `payment`: el cobro. */
  kind: 'invoice' | 'credit_note' | 'payment';
  invoiceId: string;
  fullNumber: string;
  total: number;
  startedAt: string;
}

/**
 * Resolver un envío sin confirmar:
 * - `retry`: no está en Holded → se vuelve a enviar;
 * - `already_in_holded`: sí está (documento: pegar su id de Holded).
 */
export const ResolvePlatformHoldedReviewSchema = z.object({
  kind: z.enum(['invoice', 'credit_note', 'payment']),
  action: z.enum(['retry', 'already_in_holded']),
  holdedDocumentId: z.string().trim().min(1).max(100).optional(),
});
export type ResolvePlatformHoldedReviewInput = z.infer<typeof ResolvePlatformHoldedReviewSchema>;

export * from './billing-details';
export * from './accountant-export';
