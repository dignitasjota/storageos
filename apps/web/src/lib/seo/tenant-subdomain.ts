/**
 * Origen del subdominio `<slug>.<plataforma>` de un negocio, p. ej.
 * `https://garcia.trasteros.pro`. Sin dependencias de servidor: lo usan también
 * los componentes compartidos (SEO web D4).
 */
export function tenantSubdomainOrigin(slug: string): string {
  try {
    const site = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro');
    return `${site.protocol}//${slug}.${site.host}`;
  } catch {
    return `https://${slug}.trasteros.pro`;
  }
}
