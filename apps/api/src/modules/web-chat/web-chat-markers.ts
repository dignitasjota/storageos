/**
 * Lectura de la respuesta del asistente del chat de la web: separa el texto
 * que ve el visitante de las marcas que pide el prompt (`[[RESERVA {…}]]`,
 * `[[ESPERA {…}]]`, `[[CONTACTO {…}]]`, `[[HUMANO]]`, `[[SIN_RESPUESTA]]`).
 *
 * Es tolerante con lo que el modelo escribe de más (mayúsculas, espacios, dos
 * puntos) y nunca deja una marca a la vista: si queda alguna mal escrita o
 * cortada (respuesta que llega al límite de tokens), se quita y se avisa con
 * `brokenMarker` / `brokenBooking`.
 */

export interface ParsedAssistantReply {
  /** Texto para el visitante, sin marcas ni formato Markdown. */
  text: string;
  /** JSON de la primera `[[RESERVA {…}]]`. */
  booking: string | null;
  /** JSON de la primera `[[ESPERA {…}]]`. */
  waitlist: string | null;
  /** JSON de la primera `[[CONTACTO {…}]]`. */
  contact: string | null;
  handoff: boolean;
  unanswered: boolean;
  /** Había una marca de reserva que no se pudo leer (mal escrita o cortada). */
  brokenBooking: boolean;
  /** Quedaba alguna marca mal escrita o cortada (se ha quitado). */
  brokenMarker: boolean;
}

const DATA_MARKER_RE = /\[\[\s*(RESERVA|ESPERA|CONTACTO)\s*:?\s*(\{[\s\S]*?\})\s*\]\]/gi;
const HANDOFF_RE = /\[\[\s*HUMANO\s*\]\]/gi;
const UNANSWERED_RE = /\[\[\s*SIN[\s_-]*RESPUESTA\s*\]\]/gi;
/** Cualquier otra marca cerrada. */
const OTHER_MARKER_RE = /\[\[[\s\S]*?\]\]/g;

/** Formato Markdown que el widget no pinta: se deja el texto plano. */
function plainText(text: string): string {
  return (
    text
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      // Lo que deja una marca quitada: espacios dobles y líneas con espacios.
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export function parseAssistantReply(raw: string): ParsedAssistantReply {
  const out: ParsedAssistantReply = {
    text: '',
    booking: null,
    waitlist: null,
    contact: null,
    handoff: false,
    unanswered: false,
    brokenBooking: false,
    brokenMarker: false,
  };
  let text = raw.replace(DATA_MARKER_RE, (_m, kind: string, json: string) => {
    const k = kind.toUpperCase();
    if (k === 'RESERVA') out.booking ??= json;
    else if (k === 'ESPERA') out.waitlist ??= json;
    else out.contact ??= json;
    return '';
  });
  text = text.replace(HANDOFF_RE, () => {
    out.handoff = true;
    return '';
  });
  text = text.replace(UNANSWERED_RE, () => {
    out.unanswered = true;
    return '';
  });
  text = text.replace(OTHER_MARKER_RE, (m) => {
    out.brokenMarker = true;
    if (/reserva/i.test(m)) out.brokenBooking = true;
    return '';
  });
  // Una marca sin cerrar (respuesta cortada): fuera desde ahí hasta el final.
  const open = text.indexOf('[[');
  if (open >= 0) {
    out.brokenMarker = true;
    if (/reserva/i.test(text.slice(open))) out.brokenBooking = true;
    text = text.slice(0, open);
  }
  // Si se leyó bien una reserva, una segunda mal escrita no es un fallo de reserva.
  if (out.booking) out.brokenBooking = false;
  out.text = plainText(text);
  return out;
}

/**
 * Quita los enlaces de firma (`/sign/<token>`) de un texto antes de guardarlo:
 * el visitante lo recibe en su respuesta, pero ni el panel ni el historial
 * (que se ve en el ordenador del visitante) lo vuelven a enseñar.
 */
export function redactSigningLinks(text: string, replacement: string): string {
  return text.replace(/https?:\/\/[^\s]*\/sign\/[^\s/?#]+[^\s]*/g, replacement);
}

/** DNI, NIE y CIF tecleados por el visitante, tapados para enseñarlos. */
export function redactTaxIds(text: string): string {
  return text.replace(
    /\b([XYZxyz]?\d{7,8}[A-Za-z]|[A-HJ-NP-SUVWa-hj-np-suvw]\d{7}[0-9A-Ja-j])\b/g,
    (m) => `${'•'.repeat(Math.max(0, m.length - 3))}${m.slice(-3)}`,
  );
}
