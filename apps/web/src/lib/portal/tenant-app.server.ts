import { isValidTenantSlug } from './tenant-app';

import type { PublicTenantBrandDto } from '@storageos/shared';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

/** Marca pública del operador (solo servidor), o null si no existe. */
export async function fetchPortalBrand(slug: string): Promise<PublicTenantBrandDto | null> {
  if (!isValidTenantSlug(slug)) return null;
  try {
    const res = await fetch(`${SERVER_API_URL}/public/landing/brand/${encodeURIComponent(slug)}`, {
      headers: internalApiHeaders(),
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicTenantBrandDto;
  } catch {
    return null;
  }
}

/**
 * Logo subido del operador como data URL, para dibujar el icono. Solo el
 * subido (lo sirve nuestro API desde nuestro almacenamiento): una dirección
 * pegada por el operador nunca se descarga desde el servidor.
 */
export async function fetchUploadedLogoDataUrl(slug: string): Promise<string | null> {
  if (!isValidTenantSlug(slug)) return null;
  try {
    const res = await fetch(
      `${SERVER_API_URL}/public/landing/brand/${encodeURIComponent(slug)}/logo`,
      { headers: internalApiHeaders(), next: { revalidate: 300 } },
    );
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^image\/(png|jpeg)/.test(type)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
