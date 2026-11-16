/**
 * Formato sencillo del mensaje de una campaña (y del win-back y las campañas
 * automáticas):
 * - `**negrita**`
 * - `[texto](https://…)`: un enlace con texto
 * - `[[boton: Reservar ahora | https://…]]` en su propia línea: un botón con el
 *   color de la marca.
 * Lo demás es texto: las direcciones sueltas se convierten en enlaces.
 */

const BUTTON_LINE = /^\[\[\s*bot[oó]n\s*:\s*(.+?)\s*\|\s*(https?:\/\/[^\s\]]+)\s*\]\]$/i;
const INLINE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]+)|\*\*([^*\n]+)\*\*/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const DEFAULT_COLOR = '#2563eb';

function escape(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** El texto plano del correo: el formato se quita y los enlaces quedan a la vista. */
export function campaignMarkupToText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const button = BUTTON_LINE.exec(line.trim());
      if (button) return `${button[1]}: ${button[2]}`;
      return line
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1');
    })
    .join('\n');
}

export interface CampaignMarkupOptions {
  /** Color de la marca (#rrggbb) para los botones. */
  brandColor?: string | null;
  /** Dirección a la que lleva cada enlace (el enlace con seguimiento). */
  hrefFor?: (url: string) => string;
}

function inline(line: string, href: (url: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const start = m.index ?? 0;
    out += escape(line.slice(last, start));
    let end = start + m[0].length;
    if (m[1] && m[2]) {
      out += `<a href="${escape(href(m[2]))}" style="color:#2563eb">${escape(m[1])}</a>`;
    } else if (m[3]) {
      const url = m[3].replace(TRAILING_PUNCTUATION, '');
      end = start + url.length;
      out += `<a href="${escape(href(url))}" style="color:#2563eb">${escape(url)}</a>`;
    } else if (m[4]) {
      out += `<strong>${escape(m[4])}</strong>`;
    }
    last = end;
  }
  return out + escape(line.slice(last));
}

/** El HTML del cuerpo del correo (va dentro de la carcasa del negocio). */
export function campaignMarkupToHtml(text: string, options: CampaignMarkupOptions = {}): string {
  const color =
    options.brandColor && /^#[0-9a-fA-F]{6}$/.test(options.brandColor)
      ? options.brandColor
      : DEFAULT_COLOR;
  const href = options.hrefFor ?? ((url: string) => url);
  const paragraph = (lines: string[]) =>
    `<p style="font-size:15px;line-height:24px;margin:0 0 14px">${lines
      .map((l) => inline(l, href))
      .join('<br>')}</p>`;
  const button = (label: string, url: string) =>
    `<p style="margin:24px 0;text-align:center"><a href="${escape(href(url))}" style="display:inline-block;background:${color};color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">${escape(label)}</a></p>`;
  const html: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    let pending: string[] = [];
    for (const line of lines) {
      const b = BUTTON_LINE.exec(line.trim());
      if (b) {
        if (pending.some((l) => l.trim())) html.push(paragraph(pending));
        pending = [];
        html.push(button(b[1]!, b[2]!));
      } else {
        pending.push(line);
      }
    }
    if (pending.some((l) => l.trim())) html.push(paragraph(pending.map((l) => l.trim())));
  }
  return html.join('\n');
}
