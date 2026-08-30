import { notFound, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { BookPageBody } from '../../book-shared';
import { getBookingAvailability } from '../../get-availability';

import {
  DEFAULT_PUBLIC_WEB_LOCALE,
  bookHref,
  getPublicWebMessages,
  intlLocaleFor,
  isPublicWebLocale,
} from '@/app/(public)/s/[slug]/i18n/messages';
import { TenantWebChrome } from '@/app/(public)/s/[slug]/tenant-web-chrome';

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
        <TenantWebChrome
          locale={locale}
          languageHrefBuilder={(l) => bookHref(slug, l)}
          googleAnalyticsId={data.googleAnalyticsId}
          data={{
            tenantName: data.tenantName,
            tenantSlug: data.tenantSlug,
            brandColor: data.brandColor,
            logoUrl: data.logoUrl,
          }}
        >
          <BookPageBody slug={slug} locale={locale} initialData={data} />
        </TenantWebChrome>
      ) : (
        <BookPageBody slug={slug} locale={locale} initialError={error} />
      )}
    </NextIntlClientProvider>
  );
}
