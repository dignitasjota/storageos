import { z } from 'zod';

/**
 * PUT /billing/verifactu/settings — activar o desactivar el envío a la AEAT.
 * Desactivar con registros enviados este año programa la baja para el 31 de
 * diciembre (art. 17 de la Orden HAC/1177/2024); `enabled: true` con la baja
 * programada la anula si aún no ha llegado a la AEAT.
 */
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
  /** Llevaba la renuncia a VERI*FACTU (FechaFinVeriFactu, AAAA-MM-DD). */
  fechaFinVerifactu: string | null;
  /** Llevaba registros retrasados por una incidencia (Incidencia=S). */
  incident: boolean;
}

/** `alta` (la factura o una subsanación suya) o `anulacion`. */
export type VerifactuRecordKind = 'alta' | 'anulacion';

/**
 * Un registro de facturación de una factura: su alta, las altas de subsanación
 * (lo que se corrige tras un rechazo o un aviso de la AEAT) y su anulación.
 */
export interface VerifactuRecordDto {
  id: string;
  kind: VerifactuRecordKind;
  /** Alta de subsanación. */
  subsanacion: boolean;
  /** RechazoPrevio que lleva: `X` (la AEAT no tiene la factura) o `S`. */
  rechazoPrevio: 'S' | 'X' | null;
  /** Anulación de una factura que la AEAT no tiene registrada. */
  sinRegistroPrevio: boolean;
  /** Posición en la cadena de su emisor. */
  chainSeq: number;
  status: 'pending' | 'accepted' | 'accepted_with_warnings' | 'rejected' | 'error';
  csv: string | null;
  /** Lo que dijo la AEAT (motivo del rechazo, el aviso o el fallo del envío). */
  message: string | null;
  sentAt: string | null;
  createdAt: string;
  /** Motivo de la subsanación o de la anulación. */
  reason: string | null;
  /** Generado o retrasado por una incidencia: sale con Incidencia=S. */
  incident: boolean;
  /** Envío simulado (la plataforma en modo de pruebas): no llegó a la AEAT. */
  simulated: boolean;
}

/** La baja programada de VERI*FACTU (art. 17 de la Orden HAC/1177/2024). */
export interface VerifactuRenunciaDto {
  /** Último día en VERI*FACTU (siempre un 31 de diciembre, AAAA-MM-DD). */
  endDate: string;
  /** Cuándo la recibió la AEAT con el primer envío que la llevaba (null = aún no). */
  communicatedAt: string | null;
  /**
   * Emisores con facturas ese año a los que aún no les ha salido ningún envío
   * con la renuncia: se le comunica con su próxima factura.
   */
  pendingEmitters: number;
}

/**
 * GET /billing/verifactu/alert — lo que no se ha podido enviar a la AEAT por
 * una incidencia técnica. Mientras quede algo, el panel lo avisa con el número
 * (art. 16.4 de la Orden HAC/1177/2024).
 */
export interface VerifactuAlertDto {
  unsentCount: number;
  /** Desde cuándo (el registro más antiguo sin enviar). */
  since: string | null;
  /** Lo último que falló, en palabras. */
  lastError: string | null;
}

/** GET /billing/verifactu/settings */
export interface VerifactuSettingsDto {
  enabled: boolean;
  enabledAt: string | null;
  /**
   * Con registros enviados este año no se puede apagar antes de esta fecha
   * (AAAA-MM-DD, art. 17): desactivarlo programa la baja para ese día.
   */
  lockedUntil: string | null;
  /** Baja programada (renuncia), si la hay. */
  renuncia: VerifactuRenunciaDto | null;
  /** Cómo envía la plataforma: con `stub` no llega nada a la AEAT (simulado). */
  platformMode: 'stub' | 'sandbox' | 'production';
  /** Lo que falta para poder activarlo (vacío = se puede). */
  blockers: VerifactuBlockerDto[];
  /** Facturas con Veri*Factu que aún no constan registradas (en cola o con error). */
  pendingCount: number;
  /** Facturas con Veri*Factu que la AEAT rechazó. */
  rejectedCount: number;
  /** De lo pendiente, lo que no ha podido salir por una incidencia técnica. */
  incidentCount: number;
  /** Lo último que falló al enviar, en palabras (null si va bien). */
  lastError: string | null;
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
