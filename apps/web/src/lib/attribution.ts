import {
  ATTRIBUTION_DAYS,
  detectTrafficSource,
  type TrafficSource,
  type WebEventKind,
} from '@storageos/shared';

import { measurementAllowed } from './tenant-consent';

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
  // Eligió «Solo necesarias»: no se guarda de dónde viene (y se borra lo guardado).
  if (!measurementAllowed(slug)) {
    try {
      window.localStorage.removeItem(key(slug));
    } catch {
      /* sin almacenamiento */
    }
    return;
  }
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
  const stored = measurementAllowed(slug) ? read(slug) : null;
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

const VISITOR_AT_KEY = 'storageos.promo.visitor.at';
/** El identificador se renueva pasados 13 meses (lo que dura como mucho una cookie de medición). */
const VISITOR_MAX_AGE_MS = 395 * 86_400_000;
/** Sin almacenamiento (bloqueado o modo privado): el mismo id mientras dure la página. */
let memoryVisitorId: string | null = null;

/** UUID v4, también en navegadores sin `crypto.randomUUID` (Safari < 15.4). */
function randomId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Identificador aleatorio del navegador (sin datos personales): cuenta
 * visitantes y recupera la conversación del chat. Caduca a los 13 meses.
 */
export function visitorId(): string {
  try {
    const saved = window.localStorage.getItem(VISITOR_KEY);
    const at = Number(window.localStorage.getItem(VISITOR_AT_KEY));
    if (saved && Number.isFinite(at) && at > 0 && Date.now() - at < VISITOR_MAX_AGE_MS) {
      return saved;
    }
    if (saved && !at) {
      // Guardado antes de que tuviera fecha: cuenta desde hoy.
      window.localStorage.setItem(VISITOR_AT_KEY, String(Date.now()));
      return saved;
    }
    const id = randomId();
    window.localStorage.setItem(VISITOR_KEY, id);
    window.localStorage.setItem(VISITOR_AT_KEY, String(Date.now()));
    return id;
  } catch {
    memoryVisitorId ??= randomId();
    return memoryVisitorId;
  }
}

/** Anota una página vista o un clic de contacto (best-effort: nunca rompe la página). */
export function trackWebEvent(slug: string, kind: WebEventKind, path = window.location.pathname) {
  if (typeof window === 'undefined' || navigator.webdriver) return;
  // «Solo necesarias» o «No medir mis visitas»: nada.
  if (!measurementAllowed(slug)) return;
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
