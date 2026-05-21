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
   * Envia una factura a AEAT. Devuelve el resultado del envio. NO
   * actualiza la BD: el caller (VerifactuService) actualiza el estado
   * `aeat_*` de la factura con los datos devueltos.
   */
  abstract sendInvoice(args: SendInvoiceArgs): Promise<SendInvoiceResult>;

  /** Consulta el estado de una factura ya enviada. */
  abstract getStatus(args: GetStatusArgs): Promise<GetStatusResult>;
}

export interface SendInvoiceArgs {
  tenantId: string;
  invoiceId: string;
  invoiceNumber: string;
  issueDate: Date;
  total: number;
  previousHash: string | null;
  hash: string;
  /** NIF del emisor (tenant.taxId). */
  emitterTaxId: string;
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
