import type { MetadataRoute } from 'next';

import { fetchPlatformWebsite } from '@/lib/platform-website';

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

const PRIVATE = ['/dashboard', '/settings', '/admin', '/portal', '/api/', '/widget/', '/book/'];

/**
 * robots.txt: indexa la home y las landings públicas (`/s/`); bloquea el panel
 * de staff/admin, el portal del inquilino, el widget embebible y la API. Si en
 * panel admin → Web de TrasterOS → SEO se desactiva la indexación, se bloquea
 * la web de la plataforma pero no las de los tenants (`/s/`).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = siteUrl();
  const { seo } = await fetchPlatformWebsite();
  return {
    rules: seo.indexable
      ? { userAgent: '*', allow: ['/', '/s/'], disallow: PRIVATE }
      : { userAgent: '*', allow: ['/s/'], disallow: ['/', ...PRIVATE] },
    sitemap: `${base}/sitemap.xml`,
  };
}
