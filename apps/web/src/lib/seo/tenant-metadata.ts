import type { Metadata } from 'next';

/**
 * Metadatos de una página de la web de un tenant o de su área (reserva, acceso
 * de clientes, textos legales) con SU marca: título, descripción y Open Graph
 * propios, sin «· TrasterOS» ni la descripción de la plataforma.
 *
 * Next fusiona los metadatos de cada segmento por clave de primer nivel: si la
 * página no define `description`, `openGraph` o `twitter`, hereda los del
 * layout raíz (TrasterOS). Por eso aquí se declaran todos. `title.absolute`
 * evita la plantilla `%s · TrasterOS` del layout raíz.
 */
export function tenantPageMetadata(input: {
  tenantName: string;
  title: string;
  description: string;
  locale?: 'es' | 'en';
}): Metadata {
  const { title, description, tenantName } = input;
  return {
    title: { absolute: title },
    description,
    openGraph: {
      type: 'website',
      title,
      description,
      siteName: tenantName,
      locale: input.locale === 'en' ? 'en_GB' : 'es_ES',
    },
    twitter: { card: 'summary', title, description },
  };
}

/** «No indexar» también en la metaetiqueta (además del `X-Robots-Tag` del middleware). */
export const NOINDEX_ROBOTS: NonNullable<Metadata['robots']> = { index: false, follow: false };
