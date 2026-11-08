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
}
