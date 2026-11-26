/**
 * Origen de una visita a la web del tenant (Instagram, Google Ads, un flyer…).
 *
 * Se decide con las variables del enlace (`utm_*`), los identificadores de clic
 * de los anuncios (`gclid`, `fbclid`…) o, si no hay, la web de la que viene
 * (referer). Se guarda en el navegador para que la reserva o el formulario de
 * contacto lo conozcan aunque el visitante haya entrado por la portada.
 */

export interface TrafficSource {
  source: string;
  medium?: string;
  campaign?: string;
  /** Primera página que vio el visitante al llegar con este origen (la ruta). */
  landing?: string;
}

/** Días que dura el origen guardado en el navegador. */
export const ATTRIBUTION_DAYS = 30;

const MAX = 120;
const clean = (v: string | null | undefined): string | undefined => {
  const t = v?.trim().slice(0, MAX);
  return t ? t : undefined;
};

/** Host sin `www.` y en minúsculas. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return m?.[1] ? bareHost(m[1]) : null;
}

/** Parámetros de una query (`?a=1&b=2`); sin `URLSearchParams`, que shared no tipa. */
function queryParams(search: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try {
      const key = decodeURIComponent(k.replace(/\+/g, ' '));
      if (!out.has(key)) out.set(key, decodeURIComponent(v.replace(/\+/g, ' ')));
    } catch {
      // parámetro mal codificado: se ignora
    }
  }
  return out;
}

const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Webs conocidas: dominio → origen y medio. */
const KNOWN_REFERRERS: { domains: string[]; source: string; medium: string }[] = [
  { domains: ['instagram.com'], source: 'instagram', medium: 'social' },
  {
    domains: ['facebook.com', 'fb.com', 'fb.me', 'messenger.com'],
    source: 'facebook',
    medium: 'social',
  },
  { domains: ['t.co', 'twitter.com', 'x.com'], source: 'x', medium: 'social' },
  { domains: ['linkedin.com', 'lnkd.in'], source: 'linkedin', medium: 'social' },
  { domains: ['tiktok.com'], source: 'tiktok', medium: 'social' },
  { domains: ['youtube.com', 'youtu.be'], source: 'youtube', medium: 'social' },
  { domains: ['pinterest.com', 'pinterest.es'], source: 'pinterest', medium: 'social' },
  { domains: ['whatsapp.com', 'wa.me'], source: 'whatsapp', medium: 'social' },
  { domains: ['telegram.org', 't.me'], source: 'telegram', medium: 'social' },
  { domains: ['bing.com'], source: 'bing', medium: 'organic' },
  { domains: ['duckduckgo.com'], source: 'duckduckgo', medium: 'organic' },
  { domains: ['ecosia.org'], source: 'ecosia', medium: 'organic' },
  { domains: ['yahoo.com'], source: 'yahoo', medium: 'organic' },
  { domains: ['idealista.com'], source: 'idealista', medium: 'referral' },
  { domains: ['fotocasa.es'], source: 'fotocasa', medium: 'referral' },
  { domains: ['milanuncios.com'], source: 'milanuncios', medium: 'referral' },
  { domains: ['wallapop.com'], source: 'wallapop', medium: 'referral' },
  { domains: ['habitaclia.com'], source: 'habitaclia', medium: 'referral' },
];

/** Google en cualquier país (google.es, google.com, google.co.uk…). */
const isGoogle = (host: string) => /(^|\.)google\.[a-z.]+$/.test(host);

/** Correo web: el visitante pulsó un enlace de un email. */
const WEBMAIL: { domains: string[]; source: string }[] = [
  { domains: ['mail.google.com'], source: 'gmail' },
  {
    domains: ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com'],
    source: 'outlook',
  },
  { domains: ['mail.yahoo.com'], source: 'yahoo_mail' },
];

/** Apps de Android que abren el enlace (`android-app://<paquete>`). */
const ANDROID_APPS: Record<string, TrafficSource> = {
  'com.google.android.gm': { source: 'gmail', medium: 'email' },
  'com.google.android.googlequicksearchbox': { source: 'google', medium: 'organic' },
  'com.google.android.youtube': { source: 'youtube', medium: 'social' },
  'com.facebook.katana': { source: 'facebook', medium: 'social' },
  'com.facebook.lite': { source: 'facebook', medium: 'social' },
  'com.facebook.orca': { source: 'messenger', medium: 'social' },
  'com.instagram.android': { source: 'instagram', medium: 'social' },
  'com.whatsapp': { source: 'whatsapp', medium: 'social' },
  'org.telegram.messenger': { source: 'telegram', medium: 'social' },
  'com.twitter.android': { source: 'x', medium: 'social' },
  'com.linkedin.android': { source: 'linkedin', medium: 'social' },
  'com.zhiliaoapp.musically': { source: 'tiktok', medium: 'social' },
  'com.pinterest': { source: 'pinterest', medium: 'social' },
  'com.microsoft.office.outlook': { source: 'outlook', medium: 'email' },
};

/** Origen a partir de la web de la que viene el visitante; null si es la propia o no hay. */
export function sourceFromReferrer(referrer: string, ownHosts: string[]): TrafficSource | null {
  const host = hostOf(referrer);
  if (!host) return null;
  const own = ownHosts.map(bareHost);
  if (own.some((h) => host === h)) return null;
  if (/^android-app:\/\//i.test(referrer.trim())) {
    return ANDROID_APPS[host] ?? { source: host.slice(0, MAX), medium: 'referral' };
  }
  const mail = WEBMAIL.find((w) => w.domains.some((d) => matches(host, d)));
  if (mail) return { source: mail.source, medium: 'email' };
  if (isGoogle(host)) return { source: 'google', medium: 'organic' };
  const known = KNOWN_REFERRERS.find((r) => r.domains.some((d) => matches(host, d)));
  if (known) return { source: known.source, medium: known.medium };
  return { source: host.slice(0, MAX), medium: 'referral' };
}

/**
 * Origen de la visita según su URL y el referer. Null = sin información
 * (visita directa o navegación dentro de la propia web).
 */
export function detectTrafficSource(args: {
  search: string;
  referrer: string;
  ownHosts: string[];
}): TrafficSource | null {
  const sp = queryParams(args.search);
  const utmSource = clean(sp.get('utm_source'));
  const utmMedium = clean(sp.get('utm_medium'));
  const utmCampaign = clean(sp.get('utm_campaign'));
  const fromReferrer = sourceFromReferrer(args.referrer, args.ownHosts);
  const withCampaign = (s: TrafficSource): TrafficSource =>
    utmCampaign ? { ...s, campaign: utmCampaign } : s;

  if (utmSource) {
    return withCampaign({ source: utmSource, ...(utmMedium ? { medium: utmMedium } : {}) });
  }
  // Clic en un anuncio sin variables utm.
  if (sp.get('gclid') || sp.get('gbraid') || sp.get('wbraid')) {
    return withCampaign({ source: 'google', medium: 'cpc' });
  }
  if (sp.get('msclkid')) return withCampaign({ source: 'bing', medium: 'cpc' });
  if (sp.get('ttclid')) return withCampaign({ source: 'tiktok', medium: 'cpc' });
  // Meta añade `fbclid` a cualquier enlace (también los que no son anuncios).
  if (sp.get('fbclid')) {
    const source = fromReferrer?.source === 'instagram' ? 'instagram' : 'facebook';
    return withCampaign({ source, medium: utmMedium ?? 'social' });
  }
  if (fromReferrer) return withCampaign(fromReferrer);
  return utmCampaign ? { source: 'web', campaign: utmCampaign } : null;
}

/** Largo máximo de la página de entrada que se guarda. */
export const LANDING_PATH_MAX = 300;

/** Lo que viaja a la reserva, el contacto y la lista de espera. */
export function trafficSourceToUtm(s: TrafficSource | null): {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPath?: string;
} {
  if (!s) return {};
  return {
    utmSource: s.source,
    ...(s.medium ? { utmMedium: s.medium } : {}),
    ...(s.campaign ? { utmCampaign: s.campaign } : {}),
    ...(s.landing ? { landingPath: s.landing.slice(0, LANDING_PATH_MAX) } : {}),
  };
}
