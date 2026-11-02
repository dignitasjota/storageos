/**
 * Formato de los correos que escribe el super admin (correo directo, anuncios,
 * retención). El texto admite un Markdown sencillo: párrafos, **negrita**,
 * _cursiva_, ## títulos, listas con «- », [enlaces](https://…) y direcciones
 * sueltas, que pasan a ser enlaces. Todo lo demás se escapa.
 *
 * Lo usan el API (al enviar) y el panel (vista previa), así salen iguales.
 */

const BRAND = '#2563EB';
const INK = '#0F172A';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(trimmed) ? trimmed : null;
}

const LINK_STYLE = `color:${BRAND};text-decoration:underline`;

/** Línea ya escapada → negritas, cursivas y enlaces. */
function inline(escaped: string): string {
  let out = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  // [texto](url): el texto y la URL ya vienen escapados.
  const links: string[] = [];
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, rawUrl: string) => {
    const url = safeUrl(rawUrl.replace(/&amp;/g, '&'));
    if (!url) return match;
    links.push(`<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${text}</a>`);
    return `\uE000${links.length - 1}\uE000`;
  });
  out = out.replace(
    /(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)])/g,
    (_m, pre: string, raw: string) => {
      const url = safeUrl(raw.replace(/&amp;/g, '&'));
      if (!url) return `${pre}${raw}`;
      return `${pre}<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${raw}</a>`;
    },
  );
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => links[Number(i)] ?? '');
}

/** El cuerpo en Markdown sencillo → HTML (sin la cabecera ni el pie). */
export function adminMessageHtml(markdown: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p style="margin:0 0 14px">${paragraph.map(inline).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(
        `<ul style="margin:0 0 14px;padding-left:20px">${list.map((i) => `<li style="margin:0 0 4px">${inline(i)}</li>`).join('')}</ul>`,
      );
      list = [];
    }
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = escapeHtml(raw.trimEnd());
    const button = /^\[\[\s*boton\s*:\s*([^|\]]+?)\s*\|\s*(\S+?)\s*\]\]$/i.exec(raw.trim());
    const buttonUrl = button ? safeUrl(button[2] ?? '') : null;
    if (button && buttonUrl) {
      flushParagraph();
      flushList();
      blocks.push(
        `<p style="margin:6px 0 18px"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">${escapeHtml(button[1] ?? '')}</a></p>`,
      );
      continue;
    }
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1] ?? '');
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        `<p style="margin:18px 0 8px;font-size:16px;font-weight:600;color:${INK}">${inline(heading[1] ?? '')}</p>`,
      );
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks.join('');
}

/** El cuerpo en Markdown sencillo → texto plano (sin marcas). */
export function adminMessageText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\[\[\s*boton\s*:\s*([^|\]]+?)\s*\|\s*(\S+?)\s*\]\]\s*$/gim, '$1: $2')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^\s*\*\s+/gm, '- ');
}

/** Cabecera y pie de TrasterOS alrededor de un contenido ya en HTML. */
export function platformEmailShell(innerHtml: string, footerHtml = ''): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="background:${BRAND};padding:18px 28px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:18px;font-weight:700;color:#ffffff;letter-spacing:.2px">TrasterOS</td></tr>
<tr><td style="padding:28px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:${INK}">${innerHtml}</td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #e2e8f0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:12px;line-height:1.5;color:#64748b">${footerHtml}TrasterOS · Software de gestión de trasteros</td></tr>
</table></td></tr></table></body></html>`;
}

/** El correo completo (HTML con marca + texto plano) a partir del Markdown. */
export function renderAdminEmail(
  markdown: string,
  opts: { footerHtml?: string; footerText?: string } = {},
): { html: string; text: string } {
  return {
    html: platformEmailShell(adminMessageHtml(markdown), opts.footerHtml ?? ''),
    text: `${adminMessageText(markdown)}${opts.footerText ? `\n\n—\n${opts.footerText}` : ''}`,
  };
}
