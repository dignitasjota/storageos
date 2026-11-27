/**
 * Lectura del HTML de una página para el rastreador SEO (PR 10).
 *
 * Sin dependencias: las webs del proyecto se sirven ya renderizadas en el
 * servidor y solo hacen falta unas pocas etiquetas (title, meta, link, h1, a,
 * img, html y los scripts JSON-LD), así que basta un lector de etiquetas
 * tolerante (comentarios, scripts y estilos fuera; atributos con o sin
 * comillas; entidades). Nunca ejecuta nada de la página.
 */

export interface ParsedSeoHtml {
  title: string | null;
  description: string | null;
  /** Directivas de meta robots/googlebot juntas (minúsculas). */
  robots: string;
  h1: string[];
  /** Canónica absoluta (la primera) y cuántas declara. */
  canonical: string | null;
  canonicalCount: number;
  hreflang: { lang: string; href: string }[];
  jsonLdTypes: string[];
  jsonLdInvalid: number;
  imagesTotal: number;
  imagesWithoutAlt: number;
  /** Enlaces http(s) absolutos, sin fragmento ni repetidos. */
  links: { href: string; nofollow: boolean }[];
  lang: string | null;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  iquest: '¿',
  iexcl: '¡',
  laquo: '«',
  raquo: '»',
  euro: '€',
  copy: '©',
  reg: '®',
  middot: '·',
  hellip: '…',
  ndash: '–',
  mdash: '—',
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

const clean = (s: string) => decodeHtmlEntities(s).replace(/\s+/g, ' ').trim();

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const name = m[1]!.toLowerCase();
    if (name in out) continue;
    out[name] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** URL absoluta http(s) sin fragmento; null si no es una dirección web. */
export function resolveSeoHref(href: string, base: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || h.length > MAX_SEO_LINK_LENGTH) return null;
  if (/^(mailto|tel|javascript|data|sms|whatsapp|ftp|file):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const out = u.toString();
    return out.length > MAX_SEO_LINK_LENGTH ? null : out;
  } catch {
    return null;
  }
}

function jsonLdTypesOf(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) jsonLdTypesOf(v, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
  if (obj['@graph']) jsonLdTypesOf(obj['@graph'], out);
}

/** Una etiqueta no puede medir más: más allá, el `<` es texto (y nunca se busca su fin). */
const MAX_TAG_LENGTH = 10_000;
/** Un valor de enlace más largo se descarta (no se guarda ni se pide). */
export const MAX_SEO_LINK_LENGTH = 2000;

/** `</nombre` (sin distinguir mayúsculas) a partir de una posición; -1 si no hay. */
function findCloseTag(html: string, name: string, from: number): number {
  let i = html.indexOf('</', from);
  while (i !== -1) {
    if (html.slice(i + 2, i + 2 + name.length).toLowerCase() === name) return i;
    i = html.indexOf('</', i + 2);
  }
  return -1;
}

const RAW_BLOCKS = ['script', 'style', 'template'] as const;

/**
 * Quita comentarios, scripts, estilos y plantillas y recoge el cuerpo de los
 * JSON-LD, con UN recorrido lineal del HTML (sin expresiones regulares con
 * retroceso: la página la controla un tercero y un comentario o una etiqueta sin
 * cerrar no pueden congelar el proceso). Un bloque sin cerrar se come el resto,
 * como hace un navegador.
 */
function stripBlocks(html: string, jsonLd: string[]): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  let gt = -2;
  const nextGt = (from: number): number => {
    if (gt === -2 || (gt !== -1 && gt < from)) gt = html.indexOf('>', from);
    return gt;
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      out.push(' ');
      const close = html.indexOf('-->', lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    let raw: (typeof RAW_BLOCKS)[number] | null = null;
    for (const name of RAW_BLOCKS) {
      if (html.slice(lt + 1, lt + 1 + name.length).toLowerCase() !== name) continue;
      const after = html.charAt(lt + 1 + name.length);
      if (after === '' || after === '>' || after === '/' || /\s/.test(after)) raw = name;
      break;
    }
    if (!raw) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    const openEnd = nextGt(lt);
    if (openEnd === -1 || openEnd - lt > MAX_TAG_LENGTH) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    const bodyStart = openEnd + 1;
    const close = findCloseTag(html, raw, bodyStart);
    out.push(' ');
    if (close === -1) break;
    if (raw === 'script') {
      const attrs = parseAttrs(html.slice(lt + 1 + raw.length, openEnd));
      if (/ld\+json/i.test(attrs.type ?? '')) jsonLd.push(html.slice(bodyStart, close));
    }
    const closeEnd = html.indexOf('>', close);
    i = closeEnd === -1 ? n : closeEnd + 1;
  }
  return out.join('');
}

/** Lee lo que interesa al SEO de una página HTML. */
export function parseSeoHtml(html: string, pageUrl: string): ParsedSeoHtml {
  const types = new Set<string>();
  let invalid = 0;
  const jsonLdBodies: string[] = [];
  const text = stripBlocks(html, jsonLdBodies);
  for (const raw of jsonLdBodies) {
    const body = raw.trim();
    if (!body) continue;
    try {
      jsonLdTypesOf(JSON.parse(body), types);
    } catch {
      invalid++;
    }
  }

  let base = pageUrl;
  let title: string | null = null;
  let description: string | null = null;
  const robots: string[] = [];
  const h1: string[] = [];
  let canonical: string | null = null;
  let canonicalCount = 0;
  const hreflang: { lang: string; href: string }[] = [];
  let imagesTotal = 0;
  let imagesWithoutAlt = 0;
  const links = new Map<string, boolean>();
  let lang: string | null = null;

  let inTitle = false;
  let titleBuf = '';
  let h1Depth = 0;
  let h1Buf = '';
  let svgDepth = 0;
  let lastIndex = 0;
  let pos = 0;
  let gtAt = -2;
  const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 58 || c === 45;
  for (;;) {
    // Siguiente etiqueta: recorrido lineal (el fin `>` se recuerda mientras valga).
    const lt = text.indexOf('<', pos);
    if (lt === -1) break;
    let j = lt + 1;
    const isClosing = text.charAt(j) === '/';
    if (isClosing) j++;
    if (!isNameStart(text.charCodeAt(j))) {
      pos = lt + 1;
      continue;
    }
    let k = j + 1;
    while (k < text.length && k - j < 64 && isNameChar(text.charCodeAt(k))) k++;
    if (gtAt === -2 || (gtAt !== -1 && gtAt < k)) gtAt = text.indexOf('>', k);
    if (gtAt === -1) break;
    if (gtAt - lt > MAX_TAG_LENGTH) {
      pos = lt + 1;
      continue;
    }
    pos = gtAt + 1;
    const m = {
      index: lt,
      0: '',
      1: isClosing ? '/' : '',
      2: text.slice(j, k),
      3: text.slice(k, gtAt),
    };
    const between = text.slice(lastIndex, m.index);
    lastIndex = pos;
    if (inTitle) titleBuf += between;
    if (h1Depth > 0) h1Buf += between;
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();
    const rawAttrs = m[3];

    if (name === 'svg') {
      svgDepth += closing ? -1 : rawAttrs.trim().endsWith('/') ? 0 : 1;
      if (svgDepth < 0) svgDepth = 0;
      continue;
    }
    if (name === 'title') {
      if (svgDepth > 0) continue;
      if (!closing && title === null) {
        inTitle = true;
        titleBuf = '';
      } else if (closing && inTitle) {
        inTitle = false;
        title = clean(titleBuf);
      }
      continue;
    }
    if (name === 'h1') {
      if (!closing) {
        if (h1Depth === 0) h1Buf = '';
        h1Depth++;
      } else if (h1Depth > 0) {
        h1Depth--;
        if (h1Depth === 0) h1.push(clean(h1Buf));
      }
      continue;
    }
    if (closing) continue;
    const a = parseAttrs(rawAttrs);
    switch (name) {
      case 'html':
        if (a.lang) lang = a.lang.trim();
        break;
      case 'base':
        if (a.href) base = resolveSeoHref(a.href, pageUrl) ?? base;
        break;
      case 'meta': {
        const n = (a.name ?? '').toLowerCase();
        if (n === 'description' && description === null) description = clean(a.content ?? '');
        if (n === 'robots' || n === 'googlebot') robots.push((a.content ?? '').toLowerCase());
        break;
      }
      case 'link': {
        const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
        if (rel.includes('canonical') && a.href) {
          canonicalCount++;
          if (canonical === null) canonical = resolveSeoHref(a.href, base);
        }
        if (rel.includes('alternate') && a.hreflang && a.href) {
          const href = resolveSeoHref(a.href, base);
          if (href) hreflang.push({ lang: a.hreflang.trim(), href });
        }
        break;
      }
      case 'a': {
        if (!a.href) break;
        const href = resolveSeoHref(a.href, base);
        if (!href) break;
        const nofollow = (a.rel ?? '').toLowerCase().split(/\s+/).includes('nofollow');
        links.set(href, (links.get(href) ?? true) && nofollow);
        break;
      }
      case 'img':
        imagesTotal++;
        if (!('alt' in a)) imagesWithoutAlt++;
        break;
      default:
        break;
    }
  }
  if (inTitle && title === null) title = clean(titleBuf + text.slice(lastIndex));

  return {
    title: title || null,
    description: description || null,
    robots: robots.join(','),
    h1,
    canonical,
    canonicalCount,
    hreflang,
    jsonLdTypes: [...types],
    jsonLdInvalid: invalid,
    imagesTotal,
    imagesWithoutAlt,
    links: [...links].map(([href, nofollow]) => ({ href, nofollow })),
    lang,
  };
}

/** ¿Pide no indexar (meta robots o X-Robots-Tag)? */
export function seoRobotsDirectives(
  meta: string,
  header: string | undefined,
): {
  noindex: boolean;
  nofollow: boolean;
} {
  const all = `${meta},${(header ?? '').toLowerCase()}`;
  return {
    noindex: /(^|[\s,:])(noindex|none)([\s,]|$)/.test(all),
    nofollow: /(^|[\s,:])(nofollow|none)([\s,]|$)/.test(all),
  };
}
