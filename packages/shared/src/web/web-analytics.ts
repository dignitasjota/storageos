import { z } from 'zod';

/**
 * Analítica propia de la web del tenant: páginas vistas y clics de contacto
 * (llamar, WhatsApp, email, cómo llegar), con el origen de la visita. Sin IP
 * ni datos personales y sin depender de que el visitante acepte cookies.
 */

export const WEB_EVENT_KINDS = [
  'page_view',
  'call_click',
  'whatsapp_click',
  'email_click',
  'directions_click',
] as const;
export type WebEventKind = (typeof WEB_EVENT_KINDS)[number];

export const WebEventSchema = z.object({
  visitorId: z.string().trim().min(8).max(64),
  kind: z.enum(WEB_EVENT_KINDS),
  path: z.string().trim().min(1).max(500),
  source: z.string().trim().max(120).optional(),
  medium: z.string().trim().max(120).optional(),
  campaign: z.string().trim().max(160).optional(),
});
export type WebEventInput = z.infer<typeof WebEventSchema>;

/**
 * Ruta tal como la ve el visitante en el dominio propio: en la plataforma
 * `/s/<slug>/precios` → `/precios` y `/book/<slug>` → `/reservar`.
 */
export function normalizeWebPath(path: string, slug: string): string {
  let p = (path.split(/[?#]/)[0] ?? '').trim() || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  const web = `/s/${slug}`;
  const book = `/book/${slug}`;
  if (p === web || p.startsWith(`${web}/`)) p = p.slice(web.length) || '/';
  else if (p === book || p.startsWith(`${book}/`)) p = `/reservar${p.slice(book.length)}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.slice(0, 300) || '/';
}

/** Tipo de dispositivo a partir del navegador. */
export function deviceFromUserAgent(ua: string | undefined): 'mobile' | 'tablet' | 'desktop' {
  const s = (ua ?? '').toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(s) || (/android/.test(s) && !/mobile/.test(s))) {
    return 'tablet';
  }
  if (/mobi|iphone|ipod|android|windows phone/.test(s)) return 'mobile';
  return 'desktop';
}

/** Robots, previsualizaciones de enlaces y navegadores automáticos: no cuentan. */
export function isBotUserAgent(ua: string | undefined): boolean {
  if (!ua) return true;
  return /bot[/;)]|\bbot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp\/|curl|wget|python-requests|axios|node-fetch/i.test(
    ua,
  );
}

/** Clic de contacto según el enlace pulsado (null si no lo es). */
export function contactKindFromHref(href: string): Exclude<WebEventKind, 'page_view'> | null {
  const h = href.trim().toLowerCase();
  if (h.startsWith('tel:')) return 'call_click';
  if (h.startsWith('mailto:')) return 'email_click';
  if (
    /^(https?:\/\/)?(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\//.test(h) ||
    h.startsWith('whatsapp:')
  ) {
    return 'whatsapp_click';
  }
  if (
    /^https?:\/\/(www\.)?google\.[a-z.]+\/maps/.test(h) ||
    /^https?:\/\/maps\.(google\.[a-z.]+|apple\.com)\//.test(h) ||
    /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//.test(h)
  ) {
    return 'directions_click';
  }
  return null;
}

// ============================================================================
// Informe
// ============================================================================

export const WEB_ANALYTICS_DAYS = [7, 30, 90] as const;

export interface WebAnalyticsFunnelDto {
  visitors: number;
  pageViews: number;
  calls: number;
  whatsapp: number;
  emails: number;
  directions: number;
  /** Contactos que llegaron por la web (formulario, reserva empezada, widget). */
  contacts: number;
  /** Reservas online. */
  bookings: number;
  signed: number;
  /** Con el primer pago cobrado. */
  paid: number;
  /** Cobrado en el primer pago (sin fianza ni retención). */
  revenue: number;
}

export interface WebAnalyticsSourceDto extends WebAnalyticsFunnelDto {
  /** Origen (`instagram`, `google`, `web` = directo o sin origen…). */
  source: string;
  /** Gasto de los canales de marketing con ese origen en el periodo. */
  cost: number;
  costPerBooking: number | null;
}

export interface WebAnalyticsDayDto {
  date: string;
  visitors: number;
  pageViews: number;
  contacts: number;
}

export interface WebAnalyticsPageDto {
  path: string;
  pageViews: number;
  visitors: number;
  /** Llamadas, WhatsApp, email y cómo llegar pulsados en esa página. */
  contactClicks: number;
}

export interface WebAnalyticsDto {
  days: number;
  from: string;
  to: string;
  totals: WebAnalyticsFunnelDto & { cost: number };
  /** El periodo anterior de la misma duración (para comparar). */
  previous: Pick<WebAnalyticsFunnelDto, 'visitors' | 'contacts' | 'bookings'>;
  daily: WebAnalyticsDayDto[];
  sources: WebAnalyticsSourceDto[];
  pages: WebAnalyticsPageDto[];
  devices: { device: 'mobile' | 'tablet' | 'desktop'; visitors: number }[];
}
