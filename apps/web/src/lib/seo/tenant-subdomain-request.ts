import { TENANT_SUBDOMAIN_HEADER } from '@storageos/shared';
import { headers } from 'next/headers';

/**
 * ¿La página se pide por el subdominio `<slug>.<plataforma>` del negocio? El
 * middleware pone la cabecera. Solo lo llaman las páginas (servidor): los
 * componentes compartidos no pueden importar `next/headers`, así que reciben el
 * valor como parámetro (SEO web D4).
 */
export async function isTenantSubdomainRequest(): Promise<boolean> {
  try {
    return (await headers()).get(TENANT_SUBDOMAIN_HEADER) === '1';
  } catch {
    // Fuera de una petición (build, pruebas): no es un subdominio.
    return false;
  }
}
