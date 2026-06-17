import { createCipheriv, createHmac } from 'node:crypto';

/**
 * Firma Redsys `HMAC_SHA256_V1`:
 *   1. clave derivada = 3DES-CBC(order, claveSecreta) con IV de ceros y sin
 *      padding automático (el order se rellena con ceros a múltiplo de 8).
 *   2. firma = base64( HMAC-SHA256( Ds_MerchantParameters, claveDerivada ) ).
 *
 * Es el algoritmo de las librerías oficiales de Redsys (PHP/Node). La misma
 * función firma la petición y verifica la notificación (cambia el origen del
 * `Ds_MerchantParameters` y la variante base64).
 */

export const REDSYS_ENDPOINTS = {
  test: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  live: 'https://sis.redsys.es/sis/realizarPago',
} as const;

export const REDSYS_SIGNATURE_VERSION = 'HMAC_SHA256_V1';

function deriveKey(order: string, secretKeyBase64: string): Buffer {
  const key = Buffer.from(secretKeyBase64, 'base64');
  const iv = Buffer.alloc(8, 0);
  const cipher = createCipheriv('des-ede3-cbc', key, iv);
  cipher.setAutoPadding(false);
  const orderBuf = Buffer.from(order, 'utf8');
  const paddedLen = Math.ceil(orderBuf.length / 8) * 8;
  const padded = Buffer.alloc(paddedLen, 0);
  orderBuf.copy(padded);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function hmacBase64(merchantParameters: string, derivedKey: Buffer): string {
  return createHmac('sha256', derivedKey).update(merchantParameters, 'utf8').digest('base64');
}

/** base64 → forma comparable (normaliza url-safe y quita padding). */
function normalizeBase64(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}

/** Codifica el objeto de parámetros como `Ds_MerchantParameters` (base64). */
export function encodeMerchantParameters(params: Record<string, string>): string {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
}

/** Decodifica `Ds_MerchantParameters` (sin verificar la firma). */
export function decodeMerchantParameters(dsMerchantParameters: string): Record<string, string> {
  const decoded = Buffer.from(normalizeBase64(dsMerchantParameters), 'base64').toString('utf8');
  return JSON.parse(decoded) as Record<string, string>;
}

/** Firma de la petición de pago. */
export function signRequest(
  merchantParametersBase64: string,
  order: string,
  secretKeyBase64: string,
): string {
  return hmacBase64(merchantParametersBase64, deriveKey(order, secretKeyBase64));
}

export interface NotificationVerification {
  valid: boolean;
  params: Record<string, string>;
}

/**
 * Verifica la firma de la notificación servidor-a-servidor de Redsys.
 * `dsMerchantParameters` viene tal cual lo envía el banco (base64/base64url).
 */
export function verifyNotification(
  dsMerchantParameters: string,
  dsSignature: string,
  secretKeyBase64: string,
): NotificationVerification {
  const decoded = Buffer.from(normalizeBase64(dsMerchantParameters), 'base64').toString('utf8');
  const params = JSON.parse(decoded) as Record<string, string>;
  const order = params.Ds_Order ?? params.DS_ORDER ?? '';
  const computed = hmacBase64(dsMerchantParameters, deriveKey(order, secretKeyBase64));
  const valid = normalizeBase64(computed) === normalizeBase64(dsSignature);
  return { valid, params };
}
