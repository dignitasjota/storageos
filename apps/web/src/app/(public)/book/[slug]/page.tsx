import { NextIntlClientProvider } from 'next-intl';

import { BookPageBody } from './book-shared';
import { bookingMetadata, getBookingAvailability } from './get-availability';

import type { Metadata } from 'next';

import {
  bookHref,
  getPublicWebMessages,
  intlLocaleFor,
} from '@/app/(public)/s/[slug]/i18n/messages';
import { TenantSiteChrome } from '@/app/(public)/s/[slug]/tenant-site-chrome';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return bookingMetadata(slug, 'es');
}

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const messages = await getPublicWebMessages('es');
  const { data, error } = await getBookingAvailability(slug, 'es');
  return (
    <NextIntlClientProvider locale={intlLocaleFor('es')} messages={messages}>
      {data ? (
        <TenantSiteChrome
          slug={slug}
          locale="es"
          languageHrefBuilder={(l) => bookHref(slug, l)}
          googleAnalyticsId={data.googleAnalyticsId}
          fallback={{
            tenantName: data.tenantName,
            tenantSlug: data.tenantSlug,
            brandColor: data.brandColor,
            logoUrl: data.logoUrl,
          }}
        >
          <BookPageBody slug={slug} locale="es" initialData={data} />
        </TenantSiteChrome>
      ) : (
        <BookPageBody slug={slug} locale="es" initialError={error} />
      )}
    </NextIntlClientProvider>
  );
}
