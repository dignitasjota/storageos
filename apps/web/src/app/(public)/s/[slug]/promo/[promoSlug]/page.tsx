import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { getPublicWebMessages, intlLocaleFor } from '../../i18n/messages';
import { siteUrl } from '../../landing-shared';
import { TenantWebChrome } from '../../tenant-web-chrome';
import { WebChatWidget } from '../../web-chat-widget';
import { WhatsappFloatButton } from '../../whatsapp-float-button';
import { PromoBody } from '../promo-body';
import { themeFor } from '../promo-theme';

import type { PublicPromoPageDto } from '@storageos/shared';
import type { Metadata } from 'next';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

type Params = { params: Promise<{ slug: string; promoSlug: string }> };

/** Landing en vigor, o null (no existe, apagada o caducada). Caché corta: activarla se nota enseguida. */
async function getPromo(slug: string, promoSlug: string): Promise<PublicPromoPageDto | null> {
  try {
    const res = await fetch(
      `${API_URL}/public/landing/${encodeURIComponent(slug)}/promo/${encodeURIComponent(promoSlug)}`,
      { headers: internalApiHeaders(), next: { revalidate: 30 } },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicPromoPageDto;
  } catch {
    return null;
  }
}

function promoUrl(data: PublicPromoPageDto, slug: string): string {
  const base = data.site.customDomain
    ? `https://${data.site.customDomain}`
    : `${siteUrl()}/s/${slug}`;
  return `${base}/promo/${data.promo.slug}`;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, promoSlug } = await params;
  const data = await getPromo(slug, promoSlug);
  if (!data) return { robots: { index: false, follow: false } };
  const { promo, site } = data;
  const title = promo.seoTitle ?? `${promo.headline} · ${site.tenantName}`;
  const description =
    promo.seoDescription ?? promo.subheadline ?? promo.offerText ?? site.tenantName;
  const url = promoUrl(data, slug);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    robots: promo.indexable ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      title,
      description,
      url,
      type: 'website',
      siteName: site.tenantName,
      locale: 'es_ES',
      ...(promo.heroImageUrl ? { images: [promo.heroImageUrl] } : {}),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/**
 * Landing de promoción (`/promo/<nombre>` en el dominio propio, o
 * `/s/<slug>/promo/<nombre>`). Apagada, caducada o inexistente → la web normal.
 */
export default async function PromoPage({ params }: Params) {
  const { slug, promoSlug } = await params;
  const data = await getPromo(slug, promoSlug);
  if (!data) {
    const onCustomDomain = (await headers()).get('x-storageos-tenant-slug') === slug;
    redirect(onCustomDomain ? '/' : `/s/${slug}`);
  }
  const locale = 'es';
  const messages = await getPublicWebMessages(locale);
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <TenantWebChrome
        // La cabecera con el mismo color que la landing (el de la plantilla si no hay marca).
        data={{
          ...data.site,
          brandColor: themeFor(data.site.webTemplate, data.site.brandColor).accent,
        }}
        locale={locale}
        hasBlog={data.site.hasBlog}
        googleAnalyticsId={data.site.googleAnalyticsId}
      >
        <PromoBody data={data} locale={locale} />
      </TenantWebChrome>
      <WhatsappFloatButton number={data.site.whatsappNumber} />
      <WebChatWidget
        slug={data.site.tenantSlug}
        enabled={data.site.webChatEnabled}
        tenantName={data.site.tenantName}
        brandColor={data.site.brandColor}
        customDomain={data.site.customDomain}
        aboveWhatsapp={!!data.site.whatsappNumber}
      />
    </NextIntlClientProvider>
  );
}
