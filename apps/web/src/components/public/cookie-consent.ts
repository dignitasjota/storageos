/**
 * Consentimiento de cookies de la web de TrasterOS. Las necesarias no piden
 * permiso; la analítica (Google Analytics) solo se carga con «Aceptar todas».
 */
export type CookieConsent = 'all' | 'necessary';

const CONSENT_KEY = 'storageos.cookie-consent';
/** Clave anterior (solo había cookies necesarias). */
const LEGACY_KEY = 'storageos.cookies-accepted';
export const CONSENT_EVENT = 'storageos:cookie-consent';

export function readConsent(): CookieConsent | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v === 'all' || v === 'necessary') return v;
    return localStorage.getItem(LEGACY_KEY) ? 'necessary' : null;
  } catch {
    return null;
  }
}

/** ¿Hay que preguntar? Sin respuesta, o aceptó solo lo necesario antes de que hubiera analítica. */
export function needsConsentPrompt(analytics: boolean): boolean {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v === 'all' || v === 'necessary') return false;
    if (localStorage.getItem(LEGACY_KEY)) return analytics;
    return true;
  } catch {
    return false;
  }
}

export function saveConsent(value: CookieConsent): void {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    /* sin localStorage: vale para esta visita */
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: value }));
}

/** Vuelve a mostrar el aviso (enlace «Configurar cookies» del pie). */
export function resetConsent(): void {
  try {
    localStorage.removeItem(CONSENT_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: null }));
}
