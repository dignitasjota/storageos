import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `state` de la vuelta de un inicio de sesión con Meta: negocio, usuario y
 * caducidad firmados con HMAC (clave derivada de `MASTER_ENCRYPTION_KEY`).
 * Sin él, cualquiera podría colgar la cuenta de Meta de otro en un negocio.
 *
 * Formato: `<tenantId>.<userId>.<caducidad ms>.<firma base64url>`.
 */
export function oauthStateKey(masterKey: string): Buffer {
  return createHash('sha256').update(`meta-oauth-state:v1:${masterKey}`).digest();
}

const sign = (key: Buffer, payload: string) =>
  createHmac('sha256', key).update(payload).digest('base64url').slice(0, 32);

export function buildOauthState(
  key: Buffer,
  tenantId: string,
  userId: string,
  ttlMs = 15 * 60_000,
  now = Date.now(),
): string {
  const payload = `${tenantId}.${userId}.${now + ttlMs}`;
  return `${payload}.${sign(key, payload)}`;
}

const UUID = /^[0-9a-f-]{36}$/i;

export function parseOauthState(
  key: Buffer,
  state: string,
  now = Date.now(),
): { tenantId: string; userId: string } | null {
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [tenantId, userId, exp, sig] = parts as [string, string, string, string];
  if (!UUID.test(tenantId) || !UUID.test(userId) || !/^\d{10,16}$/.test(exp)) return null;
  const expected = Buffer.from(sign(key, `${tenantId}.${userId}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) < now) return null;
  return { tenantId, userId };
}
