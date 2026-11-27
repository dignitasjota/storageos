import { headers } from 'next/headers';

import { PortalLoginClient } from './portal-login-client';

import type { Metadata } from 'next';

import { appName, iconVersion, tenantIconPath, tenantManifestPath } from '@/lib/portal/tenant-app';
import { fetchPortalBrand } from '@/lib/portal/tenant-app.server';
import { NOINDEX_ROBOTS, tenantPageMetadata } from '@/lib/seo/tenant-metadata';

type Props = { searchParams: Promise<{ slug?: string }> };

/**
 * Resuelve el tenant del login (para mostrarlo con su aspecto white-label)
 * por dos vías: `?slug=` (enlace «Acceso clientes» de nuestras plantillas,
 * prioritario) o, si se accede por el dominio propio del tenant, la cabecera
 * que fija el middleware — cubre el caso de un enlace tecleado a mano o
 * enlazado desde una web externa que el tenant aloja fuera de la plataforma.
 */
async function resolveSlug(searchParams: Props['searchParams']): Promise<string | null> {
  const { slug: querySlug } = await searchParams;
  const domainSlug = (await headers()).get('x-storageos-tenant-slug');
  return querySlug || domainSlug || null;
}

/**
 * Con operador, la página y la app que se instala llevan su nombre, color e
 * icono, y su propia descripción (sin la de TrasterOS). Acceso de clientes:
 * no se indexa (también lo pide el `X-Robots-Tag` del middleware).
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const slug = await resolveSlug(searchParams);
  const brand = slug ? await fetchPortalBrand(slug) : null;
  if (!slug || !brand || brand.portalUnavailable) return { robots: NOINDEX_ROBOTS };
  const name = appName(brand.tenantName);
  const title = `Acceso de clientes · ${name}`;
  return {
    ...tenantPageMetadata({
      tenantName: brand.tenantName,
      title,
      description: `Entra en tu área de clientes de ${brand.tenantName}: contratos, facturas, accesos y mensajes.`,
    }),
    robots: NOINDEX_ROBOTS,
    manifest: tenantManifestPath(slug),
    appleWebApp: { capable: true, statusBarStyle: 'default', title: name },
    icons: {
      icon: [
        {
          url: tenantIconPath(slug, 192, false, iconVersion(brand)),
          type: 'image/png',
          sizes: '192x192',
        },
      ],
      apple: [{ url: tenantIconPath(slug, 180, false, iconVersion(brand)), sizes: '180x180' }],
    },
  };
}

export default async function PortalLoginPage({ searchParams }: Props) {
  const slug = await resolveSlug(searchParams);
  const brand = slug ? await fetchPortalBrand(slug) : null;
  return <PortalLoginClient initialSlug={slug} initialBrand={brand} />;
}
