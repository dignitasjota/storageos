/**
 * Dirección canónica de una página de la web de un tenant, sin barra final.
 *
 * `base` es `https://<dominio propio>` (con dominio propio) o `/s/<slug>` (sin
 * él). Sin barra final: `/s/jota/`, con barra, redirige a `/s/jota` (308), y
 * una canónica que redirige no sirve para indexar. La raíz de un dominio sí
 * lleva barra (`https://dominio.com/`): es la forma normal de esa URL.
 */
export function tenantPageUrl(base: string, suffix = ''): string {
  if (suffix) return `${base}/${suffix}`;
  return base.startsWith('http') ? `${base}/` : base;
}
