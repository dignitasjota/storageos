import type { MetadataRoute } from 'next';

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

/**
 * robots.txt: indexa la home y las landings públicas (`/s/`); bloquea el panel
 * de staff/admin, el portal del inquilino, el widget embebible y la API.
 */
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/s/'],
      disallow: ['/dashboard', '/settings', '/admin', '/portal', '/api/', '/widget/', '/book/'],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
