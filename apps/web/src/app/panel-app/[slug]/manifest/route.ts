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
 * Ficha de la app del panel del equipo con la marca del tenant (plan Pro: el
 * panel solo la enlaza con «Panel con tu marca»). Su `id` es distinto del de
 * la app del portal de sus inquilinos y del panel genérico. Usa los mismos
 * iconos que la app del portal (logo subido o iniciales).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const brand = await fetchPortalBrand(slug);
  if (!brand || brand.portalUnavailable) {
    return NextResponse.redirect(new URL('/manifest-staff.webmanifest', request.url));
  }
  const name = appName(brand.tenantName);
  const v = iconVersion(brand);
  const manifest = {
    id: `/dashboard?panel=${encodeURIComponent(slug)}`,
    name: `${name} · Panel`,
    short_name: appShortName(brand.tenantName),
    description: `Panel de gestión de ${name}: contratos, inquilinos, cobros y accesos.`,
    lang: 'es-ES',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: brandColorOf(brand),
    categories: ['business', 'productivity'],
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
      'Cache-Control': 'private, max-age=300',
    },
  });
}
