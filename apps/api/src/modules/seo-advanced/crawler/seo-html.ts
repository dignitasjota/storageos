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
  if (!h || h.startsWith('#')) return null;
  if (/^(mailto|tel|javascript|data|sms|whatsapp|ftp|file):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
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

/** Lee lo que interesa al SEO de una página HTML. */
export function parseSeoHtml(html: string, pageUrl: string): ParsedSeoHtml {
  // Los JSON-LD antes de quitar los scripts.
  const types = new Set<string>();
  let invalid = 0;
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = scriptRe.exec(html); m; m = scriptRe.exec(html)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (!/ld\+json/i.test(attrs.type ?? '')) continue;
    const body = (m[2] ?? '').trim();
    if (!body) continue;
    try {
      jsonLdTypesOf(JSON.parse(body), types);
    } catch {
      invalid++;
    }
  }
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ');

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
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/g;
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    const between = text.slice(lastIndex, m.index);
    lastIndex = tagRe.lastIndex;
    if (inTitle) titleBuf += between;
    if (h1Depth > 0) h1Buf += between;
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();
    const rawAttrs = m[3] ?? '';

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
