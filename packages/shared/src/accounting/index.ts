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
}

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
});
export type UpdatePlatformHoldedSettingsInput = z.infer<typeof UpdatePlatformHoldedSettingsSchema>;

export interface PlatformHoldedSettingsDto {
  enabled: boolean;
  hasApiKey: boolean;
  invoiceSeriesId: string | null;
  /** Activa, con clave y serie: las facturas de suscripción se copian a Holded. */
  ready: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Facturas de suscripción aún sin copiar a Holded. */
  pendingCount: number;
}

export * from './billing-details';
export * from './accountant-export';
