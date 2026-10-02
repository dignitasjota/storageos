import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token del enlace de baja de las comunicaciones comerciales. No se guarda en
 * BD: identifica al destinatario (cliente `c` o lead `l`) y va firmado con
 * HMAC, así que no se puede fabricar para otra persona. No caduca (un enlace de
 * baja debe seguir funcionando en un correo antiguo).
 *
 * Formato: `<c|l>.<id>.<firma base64url>`.
 */
export type UnsubscribeKind = 'c' | 'l';

/** Clave propia derivada de la maestra (no reutiliza la de cifrado tal cual). */
export function unsubscribeKey(masterKey: string): Buffer {
  return createHash('sha256').update(`unsubscribe:v1:${masterKey}`).digest();
}

function sign(key: Buffer, kind: UnsubscribeKind, id: string): string {
  return createHmac('sha256', key).update(`${kind}:${id}`).digest('base64url');
}

export function buildUnsubscribeToken(key: Buffer, kind: UnsubscribeKind, id: string): string {
  return `${kind}.${id}.${sign(key, kind, id)}`;
}

export function parseUnsubscribeToken(
  key: Buffer,
  token: string,
): { kind: UnsubscribeKind; id: string } | null {
  const [kind, id, sig, ...rest] = token.split('.');
  if (rest.length > 0 || (kind !== 'c' && kind !== 'l') || !id || !sig) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = Buffer.from(sign(key, kind, id));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { kind, id };
}

/** «juan@gmail.com» → «j***@gmail.com». */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local[0]}***@${domain}`;
}

/** Pie de baja para el texto y el HTML de un correo comercial. */
export function appendUnsubscribeFooter(
  body: { text: string; html: string },
  url: string,
  tenantName: string,
  locale: 'es' | 'en' = 'es',
): { text: string; html: string } {
  const label =
    locale === 'en' ? 'Unsubscribe from these emails' : 'Darme de baja de estas comunicaciones';
  const why =
    locale === 'en'
      ? `You are receiving this email because you are a customer of ${tenantName} or agreed to receive its news.`
      : `Recibes este correo porque eres cliente de ${tenantName} o aceptaste recibir sus novedades.`;
  const text = `${body.text}\n\n—\n${why}\n${label}: ${url}`;
  const esc = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const footer = `<p style="margin-top:32px;font-size:12px;color:#64748b;text-align:center">${esc(why)}<br><a href="${esc(url)}" style="color:#64748b">${label}</a></p>`;
  const html = /<\/body>/i.test(body.html)
    ? body.html.replace(/<\/body>/i, `${footer}</body>`)
    : `${body.html}${footer}`;
  return { text, html };
}
