import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * `/l/es/...` → la misma página sin idioma (el español es la ruta desnuda; así
 * no hay contenido duplicado). En el dominio propio del tenant la ruta desnuda
 * es `/…`, no `/s/<slug>/…` (antes llevaba a la dirección de la plataforma).
 */
export async function redirectToDefaultLocale(slug: string, rest = ''): Promise<never> {
  const viaCustomDomain = (await headers()).get('x-storageos-tenant-slug') === slug;
  redirect(viaCustomDomain ? rest || '/' : `/s/${slug}${rest}`);
}
