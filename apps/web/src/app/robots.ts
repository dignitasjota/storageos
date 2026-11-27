import { platformRobotsRules } from '@storageos/shared';

import type { MetadataRoute } from 'next';

import { fetchPlatformWebsite } from '@/lib/platform-website';

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

/**
 * robots.txt de la plataforma: indexa la home y las webs públicas de los
 * tenants (`/s/`). No bloquea ninguna página: lo que no debe salir en Google
 * lleva `noindex` (ver `WEB_NOINDEX_PREFIXES`). Si en panel admin → Web de
 * TrasterOS → SEO se desactiva la indexación, se bloquea la web de la
 * plataforma pero no las de los tenants (`/s/`).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = siteUrl();
  const { seo } = await fetchPlatformWebsite();
  return {
    rules: platformRobotsRules(seo.indexable),
    sitemap: `${base}/sitemap.xml`,
  };
}
