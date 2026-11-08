/**
 * Cliente de envio de facturas a AEAT (Verifactu).
 *
 * Tres implementaciones:
 *   - `StubAeatClient`: dev/test. Marca `accepted` sin red.
 *   - `SandboxAeatClient`: envio real al entorno de pruebas AEAT
 *     (requiere certificado digital + firma XAdES). Stub aqui hasta
 *     que el tenant tenga certificado real, momento en el que se
 *     conecta al endpoint sandbox.
 *   - `ProductionAeatClient`: identico a sandbox pero contra el
 *     entorno de produccion AEAT.
 *
 * Seleccionado por env `AEAT_MODE=stub|sandbox|production`.
 */
export abstract class AeatClient {
  abstract get mode(): 'stub' | 'sandbox' | 'production';

  /**
   * Envía a la AEAT varios registros de un mismo emisor (el negocio o un
   * propietario), en un solo mensaje y en el orden recibido (el de su cadena).
   * Devuelve el resultado del envío y el de cada registro. NO actualiza la BD:
   * lo hace `VerifactuService`.
   */
  abstract sendBatch(args: SendBatchArgs): Promise<SendBatchResult>;

  /** Consulta el estado de una factura ya enviada. */
  abstract getStatus(args: GetStatusArgs): Promise<GetStatusResult>;
}

export interface SendBatchArgs {
  tenantId: string;
  /** Emisor propietario (plan Administrador); null = el propio negocio. */
  ownerId: string | null;
  /** Registros del emisor (`verifactu_records`), en el orden de su cadena (como mucho 1.000). */
  recordIds: readonly string[];
  /**
   * `RemisionVoluntaria` de la cabecera: la renuncia a VERI*FACTU
   * (`FechaFinVeriFactu`) y si los registros se retrasaron por una incidencia.
   */
  remision?: { fechaFinVerifactu?: Date | null; incidencia?: boolean } | null;
}

export interface SendBatchResult {
  /**
   * `sent`: la AEAT respondió al envío · `failed`: salió pero sin respuesta
   * válida (red, tiempo agotado, error de la AEAT): hay que repetirlo ·
   * `not_sent`: no llegó a salir (sin certificado, caducado…).
   */
  outcome: 'sent' | 'failed' | 'not_sent';
  /** NIF del obligado del envío. */
  emitterTaxId: string;
  /** Registros que llevó el mensaje (0 si no salió). */
  recordCount: number;
  /** Resultado del envío en conjunto (solo `sent`). */
  status?: 'accepted' | 'partially_accepted' | 'rejected';
  /** CSV del envío: lo da la AEAT si registró algún registro. */
  csv?: string | null;
  /** Segundos que la AEAT pide esperar antes del siguiente envío (solo `sent`). */
  waitSeconds?: number | null;
  message?: string;
  /** Lo que ha pasado con cada registro pedido, por su id (también los que no salieron). */
  results: Record<string, SendInvoiceResult>;
  raw?: Record<string, unknown>;
}

export interface SendInvoiceResult {
  status: 'accepted' | 'accepted_with_warnings' | 'rejected' | 'error';
  /** Codigo Seguro de Verificacion devuelto por AEAT, si aplica. */
  csv?: string | null;
  /** Mensaje legible para logs / UI. */
  message?: string;
  /** Respuesta completa para audit. */
  raw?: Record<string, unknown>;
}

export interface GetStatusArgs {
  invoiceId: string;
  /**
   * CSV devuelto por AEAT en el alta, si se tenia. AEAT acepta consultas
   * tambien sin CSV (con NIF + numero + fecha) por lo que es opcional.
   */
  csv?: string;
}

export interface GetStatusResult {
  status: 'pending' | 'accepted' | 'accepted_with_warnings' | 'rejected' | 'error';
  /** CSV definitivo devuelto por AEAT cuando la factura ya esta registrada. */
  csv?: string | null;
  message?: string;
  raw?: Record<string, unknown>;
}

export const AEAT_CLIENT = Symbol('AeatClient');
