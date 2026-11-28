import { z } from 'zod';

import type { WebIndexingStatus } from './indexing';

/**
 * Subdominios de la plataforma para la web de cada negocio (SEO web fase 1,
 * decisión D4 de `docs/SEO_WEBS_PLAN.md`).
 *
 * - `<slug>.<plataforma>` es la entrada de cada negocio. No se indexa (noindex
 *   en la cabecera y en la metaetiqueta) y no entra en ningún sitemap.
 * - Un negocio con dominio propio verificado: su subdominio redirige 308 al
 *   dominio propio (misma ruta y query). Ese es el indexable.
 * - `trasteros.pro/s/<slug>/…` redirige 308 al mismo sitio (dominio propio o
 *   subdominio), con la misma ruta.
 *
 * Todo lo que decide esto vive aquí: el middleware del web, la API (resolución)
 * y la validación de identificadores usan las mismas funciones.
 */

/**
 * Identificadores que un negocio NO puede tomar: son nombres de servicios
 * nuestros y el sistema no sirve esos subdominios como negocios.
 */
export const RESERVED_TENANT_SLUGS = [
  'api',
  'www',
  'app',
  'mail',
  'admin',
  'web',
  'static',
  'cdn',
  'files',
  'smtp',
  'ns',
  'ftp',
  'status',
  'docs',
  'help',
  'support',
  'staging',
  'dev',
  'test',
  'demo',
] as const;

const RESERVED = new Set<string>(RESERVED_TENANT_SLUGS);

/** Mismas reglas que el identificador de un negocio (`RegisterSchema`). */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isReservedTenantSlug(slug: string): boolean {
  return RESERVED.has(slug.trim().toLowerCase());
}

/** Mensaje claro para el error de un identificador reservado. */
export const RESERVED_TENANT_SLUG_MESSAGE =
  'Ese identificador está reservado para la plataforma. Elige otro.';

/** Cabecera que pone el middleware cuando la petición llega por un subdominio. */
export const TENANT_SUBDOMAIN_HEADER = 'x-storageos-subdomain';

/** Un subdominio nunca se indexa (decisión D4). */
export const TENANT_SUBDOMAIN_ROBOTS = 'noindex, nofollow';

/** Nombre del host sin puerto y en minúsculas (`localhost:3000` → `localhost`). */
export function hostNameOf(host: string): string {
  return (host.trim().toLowerCase().split(':')[0] ?? '').replace(/\.$/, '');
}

/**
 * Identificador del negocio si `host` es `<slug>.<raíz de la plataforma>`, o
 * null: el host de la plataforma, un dominio ajeno, varios niveles
 * (`a.b.trasteros.pro`) o un identificador reservado (`api.trasteros.pro`).
 * `platformHost` puede llevar puerto (en desarrollo, `localhost:3000`).
 */
export function tenantSubdomainOf(host: string, platformHost: string): string | null {
  const name = hostNameOf(host);
  const root = hostNameOf(platformHost);
  if (!name || !root || name === root) return null;
  const suffix = `.${root}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  if (!label || label.includes('.') || !SLUG_RE.test(label)) return null;
  if (RESERVED.has(label)) return null;
  return label;
}

/**
 * Resto de la ruta de un `/s/<slug>…` (`/s/guardalo/aviso-legal` → `/aviso-legal`,
 * `/s/guardalo` → `/`), o null si la ruta no es de ese negocio. Quita la barra
 * final, salvo en la raíz.
 */
export function legacySiteRest(pathname: string, slug: string): string | null {
  const prefix = `/s/${slug}`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const rest = pathname.slice(prefix.length).replace(/\/+$/, '');
  return rest === '' ? '/' : rest;
}

export interface TenantWebTarget {
  /** Host al que redirigir: el dominio propio o `<slug>.<plataforma>`. */
  host: string;
  /** Ruta con su query (sin el host). */
  path: string;
}

/**
 * Destino del 308 de `/s/<slug>…` en la plataforma: el dominio propio verificado
 * (si lo hay) o el subdominio del negocio, con la misma ruta y query. Null si la
 * ruta no es de ese `/s/<slug>`.
 */
export function legacySiteTarget(input: {
  pathname: string;
  search: string;
  slug: string;
  customDomain: string | null;
  platformHost: string;
}): TenantWebTarget | null {
  const rest = legacySiteRest(input.pathname, input.slug);
  if (rest === null) return null;
  const host = input.customDomain ?? `${input.slug}.${input.platformHost}`;
  return { host, path: `${rest}${input.search}` };
}

/** Destino del 308 de un subdominio con dominio propio: misma ruta y query. */
export function subdomainRedirectTarget(input: {
  customDomain: string;
  pathname: string;
  search: string;
}): TenantWebTarget {
  return { host: input.customDomain, path: `${input.pathname}${input.search}` };
}

/** Respuesta de la API a «¿qué hago con este subdominio?». */
export interface ResolveSubdomainDto {
  /** Existe un negocio con ese identificador (y no es reservado). */
  found: boolean;
  tenantSlug: string | null;
  /** Dominio propio verificado al que redirige el subdominio (308), o null. */
  redirectHost: string | null;
  /** La web se sirve en el subdominio (publicada, negocio activo o en prueba). */
  serves: boolean;
}

export const RESOLVE_SUBDOMAIN_NOT_FOUND: ResolveSubdomainDto = {
  found: false,
  tenantSlug: null,
  redirectHost: null,
  serves: false,
};

/** Dato de la lista del panel admin: un subdominio que falta por configurar. */
export interface AdminTenantSubdomainDto {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  status: WebIndexingStatus;
  /** Subdominio completo (`garcia.trasteros.pro`). */
  host: string;
  /** Dominio propio verificado (el subdominio redirige a él), o null. */
  redirectHost: string | null;
  /** Cuándo se marcó como configurado; null = pendiente. */
  readyAt: string | null;
}

/** Resultado de comprobar un subdominio desde el panel. */
export interface AdminSubdomainCheckDto {
  host: string;
  /** El subdominio responde con HTTP (y no con un 5xx). */
  ok: boolean;
  status: number | null;
  detail: string;
}

export const SetSubdomainReadySchema = z.object({
  ready: z.boolean(),
});
export type SetSubdomainReadyInput = z.infer<typeof SetSubdomainReadySchema>;
