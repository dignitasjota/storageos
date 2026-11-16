/**
 * Elección del visitante sobre la medición en la web de un tenant (por negocio,
 * en el navegador). `all` = acepta la analítica (Google Analytics si el negocio
 * lo tiene); `necessary` = solo lo necesario: ni Google Analytics ni la medición
 * propia de visitas. Sin elección (null), la medición propia y anónima funciona
 * y Google Analytics espera a que acepte.
 */
export type TenantConsent = 'all' | 'necessary';

export const TENANT_CONSENT_EVENT = 'storageos:tenant-cookie-consent';

const consentKey = (slug: string) => `storageos.tenant-cookies.${slug}`;

export function readTenantConsent(slug: string): TenantConsent | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(consentKey(slug));
    return v === 'all' || v === 'necessary' ? v : null;
  } catch {
    return null;
  }
}

export function writeTenantConsent(slug: string, value: TenantConsent | null): void {
  try {
    if (value) window.localStorage.setItem(consentKey(slug), value);
    else window.localStorage.removeItem(consentKey(slug));
  } catch {
    // Sin almacenamiento (modo privado): se vuelve a preguntar en la próxima visita.
  }
  window.dispatchEvent(new CustomEvent(TENANT_CONSENT_EVENT, { detail: value }));
}

/**
 * Navegador del equipo del negocio: sus visitas no cuentan. Se marca solo al
 * entrar en el panel (mismo dominio que la web en la plataforma) y, en el
 * dominio propio, abriendo la web una vez con `?no_track=1` (`?no_track=0` lo
 * quita). `off` = el usuario pidió que sí se cuenten (el panel no lo vuelve a marcar).
 */
const NO_TRACK_KEY = 'storageos.notrack';

export function isStaffBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const flag = new URLSearchParams(window.location.search).get('no_track');
    if (flag === '1') window.localStorage.setItem(NO_TRACK_KEY, '1');
    else if (flag === '0') window.localStorage.setItem(NO_TRACK_KEY, 'off');
    return window.localStorage.getItem(NO_TRACK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Marca (o desmarca) este navegador como del equipo. `auto` respeta un «sí, cuéntame». */
export function setStaffBrowser(on: boolean, auto = false): void {
  try {
    if (auto && window.localStorage.getItem(NO_TRACK_KEY) === 'off') return;
    window.localStorage.setItem(NO_TRACK_KEY, on ? '1' : 'off');
  } catch {
    // Sin almacenamiento: no se puede recordar.
  }
}

/**
 * ¿Se pueden medir sus visitas? No, si eligió «Solo necesarias» o si es el
 * navegador de alguien del equipo.
 */
export function measurementAllowed(slug: string): boolean {
  return readTenantConsent(slug) !== 'necessary' && !isStaffBrowser();
}
