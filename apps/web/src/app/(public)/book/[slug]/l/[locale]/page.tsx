import { notFound, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { BookPageBody } from '../../book-shared';
import { bookingMetadata, getBookingAvailability } from '../../get-availability';

import type { Metadata } from 'next';

import {
  DEFAULT_PUBLIC_WEB_LOCALE,
  bookHref,
  getPublicWebMessages,
  intlLocaleFor,
  isPublicWebLocale,
} from '@/app/(public)/s/[slug]/i18n/messages';
import { TenantSiteChrome } from '@/app/(public)/s/[slug]/tenant-site-chrome';
import { WebChatWidget } from '@/app/(public)/s/[slug]/web-chat-widget';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { slug, locale } = await params;
  return bookingMetadata(slug, isPublicWebLocale(locale) ? locale : 'es');
}

export default async function BookLocalePage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}) {
  const { slug, locale } = await params;
  if (!isPublicWebLocale(locale)) notFound();
  // El idioma por defecto ya vive en la ruta desnuda `/book/[slug]` — evita
  // contenido duplicado indexable en `/l/es`.
  if (locale === DEFAULT_PUBLIC_WEB_LOCALE) redirect(`/book/${slug}`);
  const messages = await getPublicWebMessages(locale);
  const { data, error } = await getBookingAvailability(slug, locale);
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      {data ? (
        <TenantSiteChrome
          slug={slug}
          locale={locale}
          languageHrefBuilder={(l) => bookHref(slug, l)}
          googleAnalyticsId={data.googleAnalyticsId}
          fallback={{
            tenantName: data.tenantName,
            tenantSlug: data.tenantSlug,
            brandColor: data.brandColor,
            logoUrl: data.logoUrl,
          }}
        >
          <BookPageBody slug={slug} locale={locale} initialData={data} />
        </TenantSiteChrome>
      ) : null}
      {data ? (
        <WebChatWidget
          slug={data.tenantSlug}
          enabled={data.webChatEnabled}
          tenantName={data.tenantName}
          brandColor={data.brandColor}
          customDomain={data.customDomain}
          aboveWhatsapp={false}
          proactive
        />
      ) : (
        <BookPageBody slug={slug} locale={locale} initialError={error} />
      )}
    </NextIntlClientProvider>
  );
}
