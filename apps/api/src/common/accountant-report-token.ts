import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Enlace del Excel que se envía a la asesoría: no exige sesión y dura 60 días
 * (una dirección firmada del almacén caduca a los 7). No se guarda en BD: lleva
 * el tenant, el fichero y la caducidad, firmados con una clave derivada de la
 * maestra.
 *
 * Formato: `<base64url(tenant|fichero|caducidad)>.<firma base64url>`.
 */

export const ACCOUNTANT_REPORT_LINK_DAYS = 60;

export function accountantReportKey(masterKey: string): Buffer {
  return createHash('sha256').update(`accountant-report:v1:${masterKey}`).digest();
}

const sign = (key: Buffer, payload: string): string =>
  createHmac('sha256', key).update(payload).digest('base64url');

export function buildAccountantReportToken(
  key: Buffer,
  tenantId: string,
  fileName: string,
  expiresAt: Date,
): string {
  const payload = Buffer.from(`${tenantId}|${fileName}|${expiresAt.getTime()}`).toString(
    'base64url',
  );
  return `${payload}.${sign(key, payload)}`;
}

/** El tenant y el fichero del enlace, si la firma es buena y no ha caducado. */
export function readAccountantReportToken(
  key: Buffer,
  token: string,
  now = new Date(),
): { tenantId: string; fileName: string } | null {
  const [payload, sig, ...rest] = token.split('.');
  if (rest.length > 0 || !payload || !sig) return null;
  const expected = Buffer.from(sign(key, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [tenantId, fileName, expires] = Buffer.from(payload, 'base64url').toString().split('|');
  if (!tenantId || !fileName || !expires) return null;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[\w.-]+$/.test(fileName)) return null;
  if (Number(expires) < now.getTime()) return null;
  return { tenantId, fileName };
}
