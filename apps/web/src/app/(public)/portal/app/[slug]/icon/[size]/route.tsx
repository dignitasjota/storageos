import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';

import { appInitials, brandColorOf, textColorOn } from '@/lib/portal/tenant-app';
import { fetchPortalBrand } from '@/lib/portal/tenant-app.server';

const SIZES = new Set([180, 192, 512]);

/** Geist Bold (la del panel): la fuente por defecto de next/og no tiene negrita. */
let fontPromise: Promise<Buffer | null> | null = null;
function boldFont(): Promise<Buffer | null> {
  // El servidor de Next (también el standalone de producción) corre en apps/web.
  fontPromise ??= readFile(join(process.cwd(), 'public/fonts/Geist-Bold.ttf')).catch(() => null);
  return fontPromise;
}

/**
 * Icono de la app del portal: iniciales del operador sobre su color. No se
 * descarga su logo (es una URL que pega el operador: el servidor no pide
 * direcciones ajenas). `?maskable=1` deja el margen que recortan Android.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; size: string }> },
): Promise<Response> {
  const { slug, size: rawSize } = await params;
  const size = Number(rawSize);
  if (!SIZES.has(size)) return new NextResponse('Not found', { status: 404 });
  const brand = await fetchPortalBrand(slug);
  if (!brand) {
    return NextResponse.redirect(
      new URL(size === 512 ? '/icon-512.png' : '/icon-192.png', request.url),
    );
  }
  const maskable = new URL(request.url).searchParams.get('maskable') === '1';
  const bg = brandColorOf(brand);
  const fg = textColorOn(bg);
  const initials = appInitials(brand.tenantName);
  // En maskable el contenido debe caber en el 80 % central.
  const font = await boldFont();
  const fontSize = Math.round(size * (maskable ? 0.32 : 0.4) * (initials.length > 1 ? 1 : 1.25));
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
        color: fg,
        fontSize,
        fontWeight: 700,
        fontFamily: font ? 'Geist' : 'sans-serif',
        letterSpacing: initials.length > 1 ? -size * 0.01 : 0,
      }}
    >
      {initials}
    </div>,
    {
      width: size,
      height: size,
      headers: { 'Cache-Control': 'public, max-age=3600' },
      ...(font
        ? { fonts: [{ name: 'Geist', data: font, weight: 700 as const, style: 'normal' as const }] }
        : {}),
    },
  );
}
