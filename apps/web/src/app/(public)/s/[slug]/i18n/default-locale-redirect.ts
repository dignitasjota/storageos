import { headers } from 'next/headers';
import { permanentRedirect } from 'next/navigation';

/**
 * `/l/es/...` → la misma página sin idioma (el español es la ruta desnuda; así
 * no hay contenido duplicado). En el dominio propio del tenant la ruta desnuda
 * es `/…`, no `/s/<slug>/…` (antes llevaba a la dirección de la plataforma).
 * Es una redirección PERMANENTE (308): `redirect()` daba 307 y Google no la
 * trata como cambio de dirección.
 */
export async function redirectToDefaultLocale(slug: string, rest = ''): Promise<never> {
  const viaCustomDomain = (await headers()).get('x-storageos-tenant-slug') === slug;
  permanentRedirect(viaCustomDomain ? rest || '/' : `/s/${slug}${rest}`);
}
