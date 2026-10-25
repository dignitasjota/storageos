import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token del enlace con seguimiento de una campaña. No se guarda en BD: lleva el
 * enlace y el destinatario (cliente `c` o contacto `l`) firmados con HMAC, así
 * que no se puede fabricar un clic para otra persona.
 *
 * Formato: `<linkId>.<c|l><recipientId>.<firma base64url>`.
 */
export function clickKey(masterKey: string): Buffer {
  return createHash('sha256').update(`campaign-click:v1:${masterKey}`).digest();
}

function sign(key: Buffer, linkId: string, recipient: string): string {
  return createHmac('sha256', key)
    .update(`${linkId}:${recipient}`)
    .digest('base64url')
    .slice(0, 22);
}

export function buildClickToken(
  key: Buffer,
  linkId: string,
  kind: 'c' | 'l',
  recipientId: string,
): string {
  const recipient = `${kind}${recipientId}`;
  return `${linkId}.${recipient}.${sign(key, linkId, recipient)}`;
}

const UUID = /^[0-9a-f-]{36}$/i;

export function parseClickToken(
  key: Buffer,
  token: string,
): { linkId: string; recipientKey: string } | null {
  const [linkId, recipient, sig, ...rest] = token.split('.');
  if (rest.length > 0 || !linkId || !recipient || !sig) return null;
  if (!UUID.test(linkId)) return null;
  const kind = recipient[0];
  const id = recipient.slice(1);
  if ((kind !== 'c' && kind !== 'l') || !UUID.test(id)) return null;
  const expected = Buffer.from(sign(key, linkId, recipient));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { linkId, recipientKey: `${kind}:${id}` };
}

/** Enlaces http(s) de un texto, sin repetir y en orden de aparición. */
export function extractLinks(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const clean = found.map((u) => u.replace(/[.,;:!?]+$/, ''));
  return [...new Set(clean)].slice(0, 20);
}
