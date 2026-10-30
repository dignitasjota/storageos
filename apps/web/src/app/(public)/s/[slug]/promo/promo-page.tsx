import { NextIntlClientProvider } from 'next-intl';

import { getPublicWebMessages, intlLocaleFor } from '../i18n/messages';
import { siteUrl } from '../landing-shared';
import { TenantWebChrome } from '../tenant-web-chrome';
import { WebChatWidget } from '../web-chat-widget';
import { WhatsappFloatButton } from '../whatsapp-float-button';

import { PromoBody } from './promo-body';
import { themeFor } from './promo-theme';

import type { PublicPromoPageDto } from '@storageos/shared';
import type { Metadata } from 'next';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

/**
 * Resultado de buscar una landing: en vigor (`page`), que existe pero ya no se
 * sirve (`gone`: apagada, caducada, sin Web Premium) o que no existe.
 */
export type PromoLookup = { page: PublicPromoPageDto } | { gone: true } | null;

/**
 * Landing en vigor (activarla o apagarla se nota al momento). Con un enlace de
 * vista previa se ve también en borrador. `viaShortPath`: la busca
 * por la dirección corta `/<nombre>` (solo valen las que la tienen activada).
 */
export async function lookupPromo(
  slug: string,
  promoSlug: string,
  opts: { preview?: string; viaShortPath?: boolean } = {},
): Promise<PromoLookup> {
  try {
    const qs = new URLSearchParams();
    if (opts.preview) qs.set('preview', opts.preview);
    if (opts.viaShortPath) qs.set('via', 'short');
    const q = qs.toString();
    const res = await fetch(
      `${SERVER_API_URL}/public/landing/${encodeURIComponent(slug)}/promo/${encodeURIComponent(promoSlug)}${q ? `?${q}` : ''}`,
      // Sin caché: Next solo guarda las respuestas 200, así que al apagar o
      // caducar una landing seguiría sirviendo la versión anterior.
      { headers: internalApiHeaders(), cache: 'no-store' },
    );
    if (res.ok) return { page: (await res.json()) as PublicPromoPageDto };
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      return body?.code === 'promo_not_available' ? { gone: true } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Dirección canónica: la corta si la tiene y hay dominio propio. */
export function promoUrl(data: PublicPromoPageDto, slug: string): string {
  if (data.site.customDomain) {
    const base = `https://${data.site.customDomain}`;
    return data.promo.shortPath ? `${base}/${data.promo.slug}` : `${base}/promo/${data.promo.slug}`;
  }
  return `${siteUrl()}/s/${slug}/promo/${data.promo.slug}`;
}

export function buildPromoMetadata(data: PublicPromoPageDto, slug: string): Metadata {
  const { promo, site } = data;
  const title = promo.seoTitle ?? `${promo.headline} · ${site.tenantName}`;
  const description =
    promo.seoDescription ||
    promo.subheadline ||
    (promo.content.offer.enabled
      ? promo.content.offer.highlight || promo.content.offer.title
      : '') ||
    site.tenantName;
  const url = promoUrl(data, slug);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    robots:
      promo.indexable && !promo.preview
        ? { index: true, follow: true }
        : { index: false, follow: !promo.preview },
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

/** La landing completa con la cabecera, el pie y los botones flotantes de la web. */
export async function PromoPageView({ data }: { data: PublicPromoPageDto }) {
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
