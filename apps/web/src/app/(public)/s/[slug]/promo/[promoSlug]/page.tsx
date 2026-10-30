import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { buildPromoMetadata, lookupPromo, PromoPageView } from '../promo-page';

import type { Metadata } from 'next';

type Params = {
  params: Promise<{ slug: string; promoSlug: string }>;
  searchParams: Promise<{ preview?: string | string[] }>;
};

function previewOf(sp: { preview?: string | string[] }): string | undefined {
  const v = Array.isArray(sp.preview) ? sp.preview[0] : sp.preview;
  return v ? v.slice(0, 300) : undefined;
}

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { slug, promoSlug } = await params;
  const found = await lookupPromo(slug, promoSlug, { preview: previewOf(await searchParams) });
  if (!found || 'gone' in found) return { robots: { index: false, follow: false } };
  return buildPromoMetadata(found.page, slug);
}

/**
 * Landing de promoción (`/promo/<nombre>` en el dominio propio, o
 * `/s/<slug>/promo/<nombre>`). Apagada, caducada o inexistente → la web normal.
 */
export default async function PromoPage({ params, searchParams }: Params) {
  const { slug, promoSlug } = await params;
  const found = await lookupPromo(slug, promoSlug, { preview: previewOf(await searchParams) });
  if (!found || 'gone' in found) {
    const onCustomDomain = (await headers()).get('x-storageos-tenant-slug') === slug;
    redirect(onCustomDomain ? '/' : `/s/${slug}`);
  }
  return <PromoPageView data={found.page} />;
}
