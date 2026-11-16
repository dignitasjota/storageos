import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma del enlace de una propuesta en su correo. Al abrirlo se anota cuándo la
 * vio y se le lleva a aceptarla; la firma impide marcar como abierta la de otro.
 */
export function offerKey(masterKey: string): Buffer {
  return createHash('sha256').update(`quote-offer-open:v1:${masterKey}`).digest();
}

export function signOffer(key: Buffer, offerId: string): string {
  return createHmac('sha256', key).update(offerId).digest('base64url').slice(0, 22);
}

export function verifyOffer(key: Buffer, offerId: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = Buffer.from(signOffer(key, offerId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
