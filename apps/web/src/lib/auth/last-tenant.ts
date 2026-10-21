/**
 * Identificador de la empresa con el que se entró por última vez en este
 * navegador: el login lo rellena solo (quien vuelve días después no suele
 * recordarlo). Es solo una comodidad; si el almacenamiento falla, no pasa nada.
 */
const KEY = 'storageos.lastTenantSlug';

export function rememberTenantSlug(slug: string): void {
  try {
    localStorage.setItem(KEY, slug);
  } catch {
    // Navegación privada o almacenamiento bloqueado.
  }
}

export function lastTenantSlug(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
