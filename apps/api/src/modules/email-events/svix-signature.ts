import { createHmac, timingSafeEqual } from 'node:crypto';

/** Tolerancia de la marca de tiempo (anti-replay), como recomienda Svix. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifica la firma de un webhook de Resend (formato Svix): HMAC-SHA256 de
 * `${svix-id}.${svix-timestamp}.${cuerpo}` con el secreto (`whsec_<base64>`),
 * en base64. La cabecera `svix-signature` trae una o varias `v1,<firma>`
 * separadas por espacios (rotación de secretos).
 */
export function verifySvixSignature(args: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signature, body } = args;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
