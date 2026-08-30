import { NextIntlClientProvider } from 'next-intl';

import { BookPageBody } from './book-shared';
import { getBookingAvailability } from './get-availability';

import {
  bookHref,
  getPublicWebMessages,
  intlLocaleFor,
} from '@/app/(public)/s/[slug]/i18n/messages';
import { TenantWebChrome } from '@/app/(public)/s/[slug]/tenant-web-chrome';

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const messages = await getPublicWebMessages('es');
  const { data, error } = await getBookingAvailability(slug, 'es');
  return (
    <NextIntlClientProvider locale={intlLocaleFor('es')} messages={messages}>
      {data ? (
        <TenantWebChrome
          locale="es"
          languageHrefBuilder={(l) => bookHref(slug, l)}
          googleAnalyticsId={data.googleAnalyticsId}
          data={{
            tenantName: data.tenantName,
            tenantSlug: data.tenantSlug,
            brandColor: data.brandColor,
            logoUrl: data.logoUrl,
          }}
        >
          <BookPageBody slug={slug} locale="es" initialData={data} />
        </TenantWebChrome>
      ) : (
        <BookPageBody slug={slug} locale="es" initialError={error} />
      )}
    </NextIntlClientProvider>
  );
}
