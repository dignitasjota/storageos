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

/** ¿Se pueden medir sus visitas? No, si eligió «Solo necesarias» o «No medir mis visitas». */
export function measurementAllowed(slug: string): boolean {
  return readTenantConsent(slug) !== 'necessary';
}
