import { NextResponse } from 'next/server';

import {
  appName,
  appShortName,
  brandColorOf,
  iconVersion,
  tenantIconPath,
} from '@/lib/portal/tenant-app';
import { fetchPortalBrand } from '@/lib/portal/tenant-app.server';

/**
 * Ficha de la app del portal con la marca del operador. Cada operador tiene su
 * `id`: el inquilino de dos operadores instala dos apps distintas. Sin
 * operador (o suspendido), la ficha genérica.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const brand = await fetchPortalBrand(slug);
  if (!brand || brand.portalUnavailable) {
    return NextResponse.redirect(new URL('/manifest.webmanifest', request.url));
  }
  const color = brandColorOf(brand);
  const v = iconVersion(brand);
  const manifest = {
    id: `/portal/app/${slug}`,
    name: appName(brand.tenantName),
    short_name: appShortName(brand.tenantName),
    description: `Tu trastero en ${appName(brand.tenantName)}: facturas, pagos y tu código de acceso.`,
    lang: 'es-ES',
    start_url: `/portal/login?slug=${encodeURIComponent(slug)}`,
    scope: '/portal',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: color,
    icons: [
      {
        src: tenantIconPath(slug, 192, false, v),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: tenantIconPath(slug, 512, false, v),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: tenantIconPath(slug, 192, true, v),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: tenantIconPath(slug, 512, true, v),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
  return new NextResponse(JSON.stringify(manifest), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
