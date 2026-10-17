import { headers } from 'next/headers';

import type { PublicSitemapEntryDto } from '@storageos/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Datos del sitemap de un tenant con dominio propio verificado, o null. Solo
 * se sirven en su dominio: el middleware reescribe `/robots.txt` y
 * `/sitemap.xml` a estas rutas y pone la cabecera con el slug.
 */
export async function tenantSeoEntry(slug: string): Promise<PublicSitemapEntryDto | null> {
  if ((await headers()).get('x-storageos-tenant-slug') !== slug) return null;
  try {
    const res = await fetch(`${API_URL}/public/landing/sitemap`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = (await res.json()) as { entries: PublicSitemapEntryDto[] };
    const entry = data.entries.find((e) => e.tenantSlug === slug);
    return entry?.customDomain ? entry : null;
  } catch {
    return null;
  }
}
