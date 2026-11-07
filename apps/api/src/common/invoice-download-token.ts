import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Enlace para descargar el PDF de una factura sin iniciar sesión: va en el
 * correo de la factura. No se guarda en BD; lleva el id de la factura y una
 * firma HMAC (con el tenant dentro), así que no se puede fabricar para otra. No
 * caduca: una factura se sigue pudiendo descargar desde un correo antiguo.
 *
 * Formato: `<id de la factura>.<firma base64url>`.
 */

/** Clave propia derivada de la maestra (no reutiliza la de cifrado tal cual). */
export function invoiceDownloadKey(masterKey: string): Buffer {
  return createHash('sha256').update(`invoice-download:v1:${masterKey}`).digest();
}

function sign(key: Buffer, tenantId: string, invoiceId: string): string {
  return createHmac('sha256', key).update(`${tenantId}:${invoiceId}`).digest('base64url');
}

export function buildInvoiceDownloadToken(
  key: Buffer,
  tenantId: string,
  invoiceId: string,
): string {
  return `${invoiceId}.${sign(key, tenantId, invoiceId)}`;
}

/** El id de la factura del enlace, sin comprobar aún la firma (falta saber su tenant). */
export function invoiceIdFromDownloadToken(token: string): string | null {
  const [id, sig, ...rest] = token.split('.');
  if (rest.length > 0 || !id || !sig || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return id;
}

export function verifyInvoiceDownloadToken(key: Buffer, token: string, tenantId: string): boolean {
  const [id, sig] = token.split('.');
  if (!id || !sig) return false;
  const expected = Buffer.from(sign(key, tenantId, id));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Dirección pública del PDF (en el API, bajo `/v1/public/invoices`). */
export function invoiceDownloadUrl(
  apiBaseUrl: string,
  key: Buffer,
  tenantId: string,
  invoiceId: string,
): string {
  const token = buildInvoiceDownloadToken(key, tenantId, invoiceId);
  return `${apiBaseUrl.replace(/\/+$/, '')}/v1/public/invoices/${token}/pdf`;
}
