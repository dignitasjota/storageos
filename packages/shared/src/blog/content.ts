/**
 * Contenido de las entradas del blog: enlaces a secciones de la web del tenant
 * y bloques (botones y widgets) dentro del Markdown.
 *
 * - Enlace a la web: `[texto](web:precios)`, `web:local/<slug>`… Se guarda la
 *   sección y no la dirección, así vale en trasteros.pro y en el dominio propio.
 * - Bloque: una línea sola con `[[boton: Texto | web:reservar]]`,
 *   `[[calculadora]]`, `[[tamanos]]` o `[[locales]]`.
 */

export const BLOG_WEB_SECTIONS = [
  'precios',
  'reservar',
  'contacto',
  'calculadora',
  'blog',
] as const;
export type BlogWebSection = (typeof BLOG_WEB_SECTIONS)[number];

export const BLOG_WEB_SECTION_LABELS: Record<BlogWebSection, string> = {
  precios: 'Trasteros, tamaños y precios',
  reservar: 'Reservar online',
  contacto: 'Contacto',
  calculadora: 'Calculadora de espacio',
  blog: 'Listado del blog',
};

/** Páginas con nombre: un local, una página de ciudad o zona, otra entrada, una landing. */
export const BLOG_WEB_PAGE_KINDS = ['local', 'pagina', 'post', 'promo'] as const;
export type BlogWebPageKind = (typeof BLOG_WEB_PAGE_KINDS)[number];

export type BlogWebLink =
  | { kind: 'section'; section: BlogWebSection }
  | { kind: BlogWebPageKind; slug: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** `web:precios` / `web:local/centro` → destino; cualquier otra cosa → null. */
export function parseWebLink(href: string | null | undefined): BlogWebLink | null {
  if (!href || !href.startsWith('web:')) return null;
  const rest = href.slice(4).trim();
  if ((BLOG_WEB_SECTIONS as readonly string[]).includes(rest)) {
    return { kind: 'section', section: rest as BlogWebSection };
  }
  const [kind, slug, extra] = rest.split('/');
  if (extra !== undefined || !slug || !SLUG_RE.test(slug)) return null;
  if (!(BLOG_WEB_PAGE_KINDS as readonly string[]).includes(kind ?? '')) return null;
  return { kind: kind as BlogWebPageKind, slug };
}

export function webLinkHref(link: BlogWebLink): string {
  return link.kind === 'section' ? `web:${link.section}` : `web:${link.kind}/${link.slug}`;
}

/** Enlace externo aceptado: solo http(s). */
export function isExternalHref(href: string | null | undefined): boolean {
  return !!href && /^https?:\/\//i.test(href);
}

export const BLOG_WIDGETS = ['calculadora', 'tamanos', 'locales'] as const;
export type BlogWidget = (typeof BLOG_WIDGETS)[number];

export const BLOG_WIDGET_LABELS: Record<BlogWidget, string> = {
  calculadora: 'Calculadora de espacio',
  tamanos: 'Tamaños y precios',
  locales: 'Locales',
};

export type BlogContentBlock =
  | { type: 'markdown'; text: string }
  | { type: 'button'; label: string; href: string }
  | { type: 'widget'; widget: BlogWidget };

const BLOCK_RE = /^\[\[\s*([a-zA-Zñáéíóú]+)\s*(?::\s*(.*?))?\s*\]\]$/;

function widgetName(name: string): BlogWidget | null {
  const n = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/gu, '');
  return (BLOG_WIDGETS as readonly string[]).includes(n) ? (n as BlogWidget) : null;
}

/**
 * Parte el Markdown en trozos de texto, botones y widgets. Un bloque solo
 * cuenta en una línea propia (fuera de bloques de código); si está mal
 * escrito se queda como texto.
 */
export function splitBlogContent(markdown: string): BlogContentBlock[] {
  const out: BlogContentBlock[] = [];
  let buffer: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buffer.join('\n');
    if (text.trim()) out.push({ type: 'markdown', text });
    buffer = [];
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : BLOCK_RE.exec(line.trim());
    if (m) {
      const name = m[1]!.toLowerCase();
      const arg = m[2] ?? '';
      if (name === 'boton' || name === 'botón') {
        const [label, href] = arg.split('|').map((x) => x.trim());
        if (label && href && (parseWebLink(href) || isExternalHref(href))) {
          flush();
          out.push({ type: 'button', label: label.slice(0, 80), href });
          continue;
        }
      } else {
        const widget = widgetName(name);
        if (widget && !arg) {
          flush();
          out.push({ type: 'widget', widget });
          continue;
        }
      }
    }
    buffer.push(line);
  }
  flush();
  return out;
}

export function buttonBlock(label: string, href: string): string {
  return `[[boton: ${label.replace(/[|\]]/g, '').trim()} | ${href}]]`;
}

export function widgetBlock(widget: BlogWidget): string {
  return `[[${widget}]]`;
}

/** Nombre de fichero para Google: sin tildes, minúsculas y guiones, sin extensión. */
export function blogImageFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
