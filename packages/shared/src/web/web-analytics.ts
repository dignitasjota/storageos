import { z } from 'zod';

import { redactSecretPaths } from './secret-paths';

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
  /** Empieza a rellenar la reserva online (elige local y tamaño o escribe su email). */
  'booking_start',
] as const;
export type WebEventKind = (typeof WEB_EVENT_KINDS)[number];

export const WebEventSchema = z.object({
  visitorId: z.string().trim().min(8).max(64),
  kind: z.enum(WEB_EVENT_KINDS),
  path: z.string().trim().min(1).max(500),
  source: z.string().trim().max(120).optional(),
  medium: z.string().trim().max(120).optional(),
  campaign: z.string().trim().max(160).optional(),
  /** Local y tamaño elegidos al empezar la reserva (`booking_start`). */
  facilityId: z.string().uuid().optional(),
  unitTypeId: z.string().uuid().optional(),
});
export type WebEventInput = z.infer<typeof WebEventSchema>;

/**
 * Ruta tal como la ve el visitante en el dominio propio: en la plataforma
 * `/s/<slug>/precios` → `/precios` y `/book/<slug>` → `/reservar`.
 */
export function normalizeWebPath(path: string, slug: string): string {
  let p = redactSecretPaths((path.split(/[?#]/)[0] ?? '').trim()) || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  const web = `/s/${slug}`;
  const book = `/book/${slug}`;
  if (p === web || p.startsWith(`${web}/`)) p = p.slice(web.length) || '/';
  else if (p === book || p.startsWith(`${book}/`)) p = `/reservar${p.slice(book.length)}`;
  // La misma página en otro idioma (`/l/en/precios`) cuenta como la misma.
  p = p.replace(/(^|\/)l\/[a-z]{2}(?=\/|$)/, '') || '/';
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.slice(0, 300) || '/';
}

/** Ruta que puede ser de la web (sin espacios ni signos raros): las demás no se guardan. */
export function isValidWebPath(path: string): boolean {
  return /^\/[\p{L}\p{N}\-._~/%@+!$&'()*,;=:]*$/u.test(path) && path.length <= 300;
}

/** Desde cuándo hay analítica propia: un periodo anterior no tiene datos de antes. */
export const WEB_ANALYTICS_START = '2026-10-22';

/** Tipo de dispositivo a partir del navegador. */
export function deviceFromUserAgent(ua: string | undefined): 'mobile' | 'tablet' | 'desktop' {
  const s = (ua ?? '').toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(s) || (/android/.test(s) && !/mobile/.test(s))) {
    return 'tablet';
  }
  if (/mobi|iphone|ipod|android|windows phone/.test(s)) return 'mobile';
  return 'desktop';
}

/**
 * Robots, previsualizaciones de enlaces y navegadores automáticos: no cuentan.
 * Incluye los de Google que ejecutan JavaScript (AdsBot visita cada landing de
 * los anuncios) y las herramientas de medir la velocidad.
 */
export function isBotUserAgent(ua: string | undefined): boolean {
  if (!ua) return true;
  return /bot[/;)]|\bbot\b|adsbot|slackbot|vkshare|embedly|iframely|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp\/|curl|wget|python-requests|axios|node-fetch|google-inspectiontool|googleother|storebot-google|mediapartners-google|apis-google|feedfetcher|gtmetrix|pingdom|uptimerobot/i.test(
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
  /** Cobrado en el primer pago: sin IVA, sin fianza, sin compensaciones ni retención y descontando devoluciones. */
  revenue: number;
}

export interface WebAnalyticsSourceDto extends WebAnalyticsFunnelDto {
  /**
   * Origen (`instagram`, `google`, `web` = directo o sin origen…). Los anuncios
   * de Facebook e Instagram van juntos como `meta`.
   */
  source: string;
  /** Tráfico de pago (`cpc`, `paid_social`…): fila aparte de la orgánica. */
  paidTraffic: boolean;
  /** Gasto de los canales de marketing con ese origen en el periodo. */
  cost: number;
  costPerBooking: number | null;
  /** Página por la que más se entra desde ese origen. */
  entryPath: string | null;
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

/** Embudo de la reserva online: dónde se queda la gente. */
export interface WebBookingFunnelDto {
  visitors: number;
  /** Abrieron la página de la reserva. */
  bookingPage: number;
  /** Empezaron a rellenarla (eligieron tamaño o escribieron su email). */
  started: number;
  bookings: number;
  signed: number;
  paid: number;
}

/** Clics en llamar y WhatsApp por día de la semana (0 = domingo) y hora (zona del negocio). */
export interface WebContactHourDto {
  weekday: number;
  hour: number;
  calls: number;
  whatsapp: number;
}

/** Interés por local y tamaño: visitas a la ficha del local y reservas empezadas. */
export interface WebDemandDto {
  facilityId: string;
  facilityName: string;
  pageViews: number;
  bookingStarts: number;
  sizes: { unitTypeId: string; name: string; bookingStarts: number }[];
}

/** Anotación en la gráfica (una campaña, una promoción, una publicación…). */
export interface MarketingAnnotationDto {
  /** null en las automáticas (no se pueden borrar). */
  id: string | null;
  day: string;
  text: string;
  kind: 'manual' | 'channel' | 'promotion' | 'campaign' | 'post';
}

export interface WebAnalyticsDto {
  days: number;
  from: string;
  to: string;
  /** Visitantes que no habían venido antes del periodo, y los que vuelven. */
  newVisitors: number;
  returningVisitors: number;
  bookingFunnel: WebBookingFunnelDto;
  contactHours: WebContactHourDto[];
  demand: WebDemandDto[];
  annotations: MarketingAnnotationDto[];
  totals: WebAnalyticsFunnelDto & {
    cost: number;
    /** Reservas del periodo que siguen en pie sin firmar (las caducadas no). */
    pendingSignature: number;
    /** Firmadas que siguen en pie con el primer pago pendiente. */
    signedUnpaid: number;
  };
  /** El periodo anterior de la misma duración (para comparar). */
  previous: Pick<WebAnalyticsFunnelDto, 'visitors' | 'contacts' | 'bookings'>;
  /**
   * El periodo anterior tiene datos completos (el negocio y la medición ya
   * existían): si no, no se enseña la variación.
   */
  previousComplete: boolean;
  /** Qué importes puede ver quien consulta (sin permiso salen a 0). */
  money: { revenue: boolean; cost: boolean };
  daily: WebAnalyticsDayDto[];
  sources: WebAnalyticsSourceDto[];
  pages: WebAnalyticsPageDto[];
  devices: { device: 'mobile' | 'tablet' | 'desktop'; visitors: number }[];
}
