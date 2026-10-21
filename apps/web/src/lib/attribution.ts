import {
  ATTRIBUTION_DAYS,
  detectTrafficSource,
  type TrafficSource,
  type WebEventKind,
} from '@storageos/shared';

/**
 * Origen de la visita a la web de un tenant, guardado en el navegador
 * (`localStorage`, sin datos personales) durante `ATTRIBUTION_DAYS` días.
 *
 * Así una reserva o un formulario de contacto saben que el visitante llegó
 * desde Instagram o un anuncio aunque entrara por la portada y navegara antes
 * de reservar. Gana la última visita con origen conocido (un enlace con utm o
 * un clic en un anuncio siempre; una web externa, una vez por sesión del
 * navegador); las visitas directas y la navegación interna no lo cambian.
 */

interface StoredSource extends TrafficSource {
  landing: string;
  at: number;
}

const key = (slug: string) => `storageos.attribution.${slug}`;
const seenKey = (slug: string) => `storageos.attribution.seen.${slug}`;

function platformHost(): string[] {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!site) return [];
  try {
    return [new URL(site).host];
  } catch {
    return [];
  }
}

function read(slug: string): StoredSource | null {
  try {
    const raw = window.localStorage.getItem(key(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSource;
    if (!parsed.source || Date.now() - parsed.at > ATTRIBUTION_DAYS * 86_400_000) {
      window.localStorage.removeItem(key(slug));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Anota el origen de la visita actual si trae uno. Se puede llamar varias veces. */
export function recordVisit(slug: string): void {
  if (typeof window === 'undefined') return;
  const ownHosts = [window.location.host, ...platformHost()];
  const search = window.location.search;
  // Origen que trae la propia URL (utm, clic en un anuncio): siempre manda.
  const fromUrl = detectTrafficSource({ search, referrer: '', ownHosts });
  // El referer solo cuenta en la primera página de la sesión: al navegar dentro
  // de la web el navegador sigue dando el referer con el que se entró (y
  // pisaría la campaña de un enlace con utm).
  let firstPage = false;
  try {
    firstPage = !window.sessionStorage.getItem(seenKey(slug));
    window.sessionStorage.setItem(seenKey(slug), '1');
  } catch {
    firstPage = false;
  }
  const detected =
    fromUrl ??
    (firstPage ? detectTrafficSource({ search, referrer: document.referrer, ownHosts }) : null);
  if (!detected) return;
  const stored: StoredSource = { ...detected, landing: window.location.pathname, at: Date.now() };
  try {
    window.localStorage.setItem(key(slug), JSON.stringify(stored));
  } catch {
    // Navegación privada o almacenamiento bloqueado: se sigue usando la URL.
  }
}

/** Origen a usar al enviar una reserva o un contacto (null si no se sabe). */
export function currentTrafficSource(slug: string): TrafficSource | null {
  if (typeof window === 'undefined') return null;
  recordVisit(slug);
  const stored = read(slug);
  if (stored) {
    return {
      source: stored.source,
      ...(stored.medium ? { medium: stored.medium } : {}),
      ...(stored.campaign ? { campaign: stored.campaign } : {}),
    };
  }
  // Sin almacenamiento disponible: al menos lo que trae la URL.
  return detectTrafficSource({
    search: window.location.search,
    referrer: '',
    ownHosts: [window.location.host],
  });
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
/** Se conserva la clave de las landings para no contar dos veces al mismo visitante. */
const VISITOR_KEY = 'storageos.promo.visitor';

/** Identificador aleatorio del navegador (sin datos personales) para contar visitantes. */
export function visitorId(): string {
  try {
    const saved = window.localStorage.getItem(VISITOR_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    window.localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Anota una página vista o un clic de contacto (best-effort: nunca rompe la página). */
export function trackWebEvent(slug: string, kind: WebEventKind, path = window.location.pathname) {
  if (typeof window === 'undefined' || navigator.webdriver) return;
  const origin = currentTrafficSource(slug);
  void fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visitorId: visitorId(),
      kind,
      path,
      ...(origin?.source ? { source: origin.source } : {}),
      ...(origin?.medium ? { medium: origin.medium } : {}),
      ...(origin?.campaign ? { campaign: origin.campaign } : {}),
    }),
    keepalive: true,
  }).catch(() => undefined);
}
