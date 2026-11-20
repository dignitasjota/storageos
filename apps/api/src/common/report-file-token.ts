import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Enlace de un informe que se envía por correo: no exige sesión y vale lo
 * mismo que el fichero (7 días). No se guarda en BD: lleva el tenant, el
 * informe y la caducidad, firmados con una clave derivada de la maestra.
 *
 * Formato: `<base64url(tenant|informe|caducidad)>.<firma base64url>`.
 */
export function reportFileKey(masterKey: string): Buffer {
  return createHash('sha256').update(`report-file:v1:${masterKey}`).digest();
}

const sign = (key: Buffer, payload: string): string =>
  createHmac('sha256', key).update(payload).digest('base64url');

export function buildReportFileToken(
  key: Buffer,
  tenantId: string,
  runId: string,
  expiresAt: Date,
): string {
  const payload = Buffer.from(`${tenantId}|${runId}|${expiresAt.getTime()}`).toString('base64url');
  return `${payload}.${sign(key, payload)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El tenant y el informe del enlace, si la firma es buena y no ha caducado. */
export function readReportFileToken(
  key: Buffer,
  token: string,
  now = new Date(),
): { tenantId: string; runId: string } | null {
  const [payload, sig, ...rest] = token.split('.');
  if (rest.length > 0 || !payload || !sig) return null;
  const expected = Buffer.from(sign(key, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [tenantId, runId, expires] = Buffer.from(payload, 'base64url').toString().split('|');
  if (!tenantId || !runId || !expires || !UUID.test(tenantId) || !UUID.test(runId)) return null;
  if (Number(expires) < now.getTime()) return null;
  return { tenantId, runId };
}
