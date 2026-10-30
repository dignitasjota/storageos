import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Enlace de vista previa de una landing de promoción (también en borrador). No
 * se guarda en BD: lleva la landing y la caducidad firmadas con HMAC, así que no
 * sirve para otra landing ni después de caducar.
 *
 * Formato: `<landingId>.<caducidad en ms>.<firma base64url>`.
 */
export const PROMO_PREVIEW_TTL_MS = 30 * 60_000;

export function promoPreviewKey(masterKey: string): Buffer {
  return createHash('sha256').update(`promo-preview:v1:${masterKey}`).digest();
}

function sign(key: Buffer, landingId: string, expires: number): string {
  return createHmac('sha256', key).update(`${landingId}:${expires}`).digest('base64url');
}

export function buildPromoPreviewToken(
  key: Buffer,
  landingId: string,
  expires: number = Date.now() + PROMO_PREVIEW_TTL_MS,
): string {
  return `${landingId}.${expires}.${sign(key, landingId, expires)}`;
}

/** La landing del token si la firma es buena y no ha caducado; si no, null. */
export function verifyPromoPreviewToken(
  key: Buffer,
  token: string,
  now: number = Date.now(),
): string | null {
  const [landingId, exp, sig, ...rest] = token.split('.');
  if (rest.length > 0 || !landingId || !exp || !sig) return null;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires <= now) return null;
  const expected = Buffer.from(sign(key, landingId, expires));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return landingId;
}
