import type { MarketingChannelType } from './index';

/**
 * A qué canal de marketing se atribuye una visita, un contacto o una reserva.
 *
 * Cada uno va a un canal como mucho (nunca a dos): primero por la campaña del
 * enlace (`utm_campaign` con el id del canal, que ponen sus enlaces cortos y
 * QR, o con el id de la campaña en Google Ads o Meta), después por el origen.
 * Un canal de anuncios (Google Ads, Meta Ads) solo recoge el tráfico de pago
 * de su origen: las visitas orgánicas de Google o las publicaciones de
 * Instagram no cuentan como resultado de un anuncio.
 */

/** Lo que se sabe del origen de una visita o de un contacto. */
export interface TrafficTouch {
  source: string | null | undefined;
  medium?: string | null;
  campaign?: string | null;
}

/** Lo que hace falta de un canal para atribuirle tráfico. */
export interface AttributableChannel {
  id: string;
  name: string;
  type: MarketingChannelType | string;
  status: string;
  utmSourceMatch: string | null;
  externalCampaignId: string | null;
  externalUrl?: string | null;
  createdAt: Date | string;
  /**
   * Canal borrado: solo recoge lo que llega con su campaña (los enlaces y QR
   * suyos que siguen impresos); su origen ya es de los canales vivos.
   */
  deletedAt?: Date | string | null;
}

/** Medios de pago (estándar de Google Analytics y los habituales de Meta). */
const PAID_MEDIA = new Set([
  'cpc',
  'ppc',
  'cpm',
  'cpv',
  'cpa',
  'paid',
  'paidsearch',
  'paid_search',
  'paid-search',
  'paidsocial',
  'paid_social',
  'paid-social',
  'social_paid',
  'social-paid',
  'display',
  'banner',
  'sem',
  'ads',
  'ad',
]);

/** ¿Es tráfico de pago? (`cpc`, `paid_social`, `display`…). */
export function isPaidMedium(medium: string | null | undefined): boolean {
  const m = (medium ?? '').trim().toLowerCase();
  if (!m) return false;
  return PAID_MEDIA.has(m) || m.startsWith('paid') || m.endsWith('_paid') || m.endsWith('-paid');
}

/** Nombres que usan las plataformas para el mismo origen. */
const SOURCE_ALIASES: Record<string, string> = {
  ig: 'instagram',
  'instagram.com': 'instagram',
  'l.instagram.com': 'instagram',
  'com.instagram.android': 'instagram',
  fb: 'facebook',
  'facebook.com': 'facebook',
  'm.facebook.com': 'facebook',
  'l.facebook.com': 'facebook',
  'lm.facebook.com': 'facebook',
  'com.facebook.katana': 'facebook',
  msg: 'messenger',
  an: 'audience_network',
  adwords: 'google',
  googleads: 'google',
  google_ads: 'google',
  'google-ads': 'google',
  'google.com': 'google',
  'google.es': 'google',
  'idealista.com': 'idealista',
  'fotocasa.es': 'fotocasa',
};

/** Orígenes de Meta: sus anuncios van juntos en una sola fila. */
const META_SOURCES = new Set([
  'meta',
  'facebook',
  'instagram',
  'messenger',
  'audience_network',
  'threads',
]);

/** Origen en minúsculas y con los alias unificados (`ig` → `instagram`). */
export function normalizeTrafficSource(source: string | null | undefined): string {
  const s = (source ?? '').trim().toLowerCase();
  if (!s) return 'web';
  return SOURCE_ALIASES[s] ?? s;
}

/**
 * Clave del origen en los informes: el origen normalizado y si es de pago.
 * Los anuncios de Facebook e Instagram son la misma campaña de Meta, así que
 * van juntos como `meta`.
 */
export function trafficKey(touch: TrafficTouch): { source: string; paid: boolean } {
  const source = normalizeTrafficSource(touch.source);
  const paid = isPaidMedium(touch.medium);
  return { source: paid && META_SOURCES.has(source) ? 'meta' : source, paid };
}

/** Portales que se reconocen por el nombre o la dirección del canal. */
const KNOWN_PORTALS = [
  'idealista',
  'fotocasa',
  'habitaclia',
  'milanuncios',
  'wallapop',
  'pisos',
  'yaencontre',
  'tablondeanuncios',
];

const AD_TYPES = new Set(['google_ads', 'meta_ads']);

/** ¿Es un canal de anuncios? Solo recoge el tráfico de pago de su origen. */
export function isAdChannel(channel: Pick<AttributableChannel, 'type'>): boolean {
  return AD_TYPES.has(channel.type);
}

/**
 * Orígenes que recoge un canal: los que se escribieron en él (separados por
 * comas) y los propios de su tipo, aunque no se escribieran (Google Ads →
 * `google`, Meta Ads → `meta`, un portal conocido por su nombre o dirección).
 */
export function channelSources(channel: AttributableChannel): string[] {
  const ad = isAdChannel(channel);
  const out = new Set<string>();
  for (const part of (channel.utmSourceMatch ?? '').split(',')) {
    const s = normalizeTrafficSource(part);
    if (part.trim() && s !== 'web') out.add(ad && META_SOURCES.has(s) ? 'meta' : s);
  }
  if (channel.type === 'google_ads') out.add('google');
  if (channel.type === 'meta_ads') out.add('meta');
  if (channel.type === 'real_estate_portal') {
    const text = `${channel.name} ${channel.externalUrl ?? ''}`.toLowerCase();
    for (const portal of KNOWN_PORTALS) if (text.includes(portal)) out.add(portal);
  }
  return [...out];
}

/** Origen que se propone al crear un canal sin escribir ninguno. */
export function defaultChannelSource(args: {
  type: MarketingChannelType;
  name: string;
  externalUrl?: string | null;
  fallback: string;
}): string {
  if (args.type === 'google_ads') return 'google';
  if (args.type === 'meta_ads') return 'facebook, instagram';
  if (args.type === 'real_estate_portal') {
    const text = `${args.name} ${args.externalUrl ?? ''}`.toLowerCase();
    const portal = KNOWN_PORTALS.find((p) => text.includes(p));
    if (portal) return portal;
  }
  return args.fallback;
}

const time = (d: Date | string) => (typeof d === 'string' ? Date.parse(d) : d.getTime());

/** Orden estable entre canales que empatan: los vivos y activos y, entre ellos, el más antiguo. */
function byPriority<T extends AttributableChannel>(a: T, b: T): number {
  const live = (c: T) => (c.deletedAt ? 1 : 0);
  const active = (c: T) => (c.status === 'active' ? 0 : 1);
  return (
    live(a) - live(b) ||
    active(a) - active(b) ||
    time(a.createdAt) - time(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/** Nivel de coincidencia de un canal con una visita (0 = no coincide). */
function matchLevel(channel: AttributableChannel, touch: TrafficTouch): number {
  const campaign = (touch.campaign ?? '').trim().toLowerCase();
  if (
    campaign &&
    (campaign === channel.id.toLowerCase() ||
      (channel.externalCampaignId && campaign === channel.externalCampaignId.toLowerCase()))
  ) {
    return 3;
  }
  if (channel.deletedAt) return 0;
  const key = trafficKey(touch);
  if (isAdChannel(channel)) {
    return key.paid && channelSources(channel).includes(key.source) ? 2 : 0;
  }
  // Un canal que no es de anuncios recoge su origen con cualquier medio.
  const plain = normalizeTrafficSource(touch.source);
  return channelSources(channel).includes(plain) ? 1 : 0;
}

/** Canal al que se atribuye una visita o un contacto (null si a ninguno). */
export function attributeChannel<T extends AttributableChannel>(
  channels: readonly T[],
  touch: TrafficTouch,
): T | null {
  let best: T | null = null;
  let bestLevel = 0;
  for (const c of channels) {
    const level = matchLevel(c, touch);
    if (level === 0) continue;
    if (level > bestLevel || (level === bestLevel && best && byPriority(c, best) < 0)) {
      best = c;
      bestLevel = level;
    }
  }
  return best;
}

/**
 * Canales que comparten origen con otro del mismo nivel: los contactos de ese
 * origen van solo al primero (el activo más antiguo), salvo que el enlace
 * lleve la campaña del canal. Devuelve, por canal, el nombre del otro.
 */
export function channelSourceConflicts(
  channels: readonly AttributableChannel[],
): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = [...channels].filter((c) => !c.deletedAt).sort(byPriority);
  for (const c of sorted) {
    const mine = new Set(channelSources(c));
    const other = sorted.find(
      (d) =>
        d.id !== c.id &&
        isAdChannel(d) === isAdChannel(c) &&
        channelSources(d).some((s) => mine.has(s)),
    );
    if (other) out.set(c.id, other.name);
  }
  return out;
}

/**
 * Origen con el que un canal aparece en los informes por origen (su gasto va
 * a esa fila): el de su tipo en los de anuncios y, en los demás, el primero
 * que recoge. null si no recoge ninguno.
 */
export function channelReportSource(channel: AttributableChannel): string | null {
  if (channel.type === 'google_ads') return 'google';
  if (channel.type === 'meta_ads') return 'meta';
  return channelSources(channel)[0] ?? null;
}

const SOURCE_NAMES: Record<string, string> = {
  web: 'Directo / sin origen',
  google: 'Google',
  meta: 'Meta (Facebook e Instagram)',
  instagram: 'Instagram',
  facebook: 'Facebook',
  messenger: 'Messenger',
  bing: 'Bing',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  x: 'X (Twitter)',
  whatsapp: 'WhatsApp',
  gmail: 'Gmail',
  outlook: 'Outlook',
  yahoo_mail: 'Yahoo Mail',
  telegram: 'Telegram',
  pinterest: 'Pinterest',
  idealista: 'Idealista',
  fotocasa: 'Fotocasa',
  habitaclia: 'Habitaclia',
  milanuncios: 'Milanuncios',
  wallapop: 'Wallapop',
};

/**
 * Canal que se propone para un origen que no recoge ninguno: el tipo según el
 * origen (anuncios de Google o Meta, un portal conocido) y su nombre.
 */
export function suggestChannelForSource(
  source: string,
  paid: boolean,
): { type: MarketingChannelType; name: string; utmSourceMatch: string } {
  if (paid && source === 'google') {
    return { type: 'google_ads', name: 'Anuncios de Google', utmSourceMatch: 'google' };
  }
  if (paid && source === 'meta') {
    return {
      type: 'meta_ads',
      name: 'Anuncios de Facebook e Instagram',
      utmSourceMatch: 'facebook, instagram',
    };
  }
  const name = trafficSourceName(source, paid);
  if (KNOWN_PORTALS.includes(source)) {
    return { type: 'real_estate_portal', name, utmSourceMatch: source };
  }
  return { type: 'other', name, utmSourceMatch: source };
}

/** Nombre de un origen para el panel y los correos («Anuncios de Google», «Instagram»…). */
export function trafficSourceName(
  source: string,
  paid = false,
  fallback?: (source: string) => string,
): string {
  if (paid && source === 'google') return 'Anuncios de Google';
  if (paid && source === 'meta') return 'Anuncios de Meta (Facebook e Instagram)';
  const base = SOURCE_NAMES[source] ?? (fallback ? fallback(source) : source);
  return paid ? `${base} (anuncios)` : base;
}
