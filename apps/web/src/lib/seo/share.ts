import type { Metadata } from 'next';

import { SITE_URL } from '@/lib/marketing/site';

/**
 * Imagen para redes de la plataforma: la de `/opengraph-image` (la que se sube
 * en el panel admin → Web de TrasterOS → SEO, o la genérica si no hay). Ruta
 * relativa: `metadataBase` la resuelve a la dirección absoluta.
 */
export const PLATFORM_SHARE_IMAGE = '/opengraph-image';

/**
 * Bloque `openGraph` de una página interior de la plataforma. Declara su
 * propia `url` (sin ella, Next hereda la de la portada) y la imagen para redes.
 * `image` solo se usa cuando la página tiene una propia (p. ej. la portada de
 * un artículo del blog).
 */
export function shareOpenGraph(args: {
  path: string;
  title: string;
  description?: string;
  type?: 'website' | 'article';
  image?: { url: string; alt?: string };
}): NonNullable<Metadata['openGraph']> {
  return {
    type: args.type ?? 'website',
    url: `${SITE_URL}${args.path}`,
    title: args.title,
    ...(args.description ? { description: args.description } : {}),
    siteName: 'TrasterOS',
    locale: 'es_ES',
    images: [args.image ?? { url: PLATFORM_SHARE_IMAGE, alt: 'TrasterOS' }],
  } as NonNullable<Metadata['openGraph']>;
}
