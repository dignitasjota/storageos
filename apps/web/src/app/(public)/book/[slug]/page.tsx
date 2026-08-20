import { NextIntlClientProvider } from 'next-intl';

import { BookPageBody } from './book-shared';

import { getPublicWebMessages, intlLocaleFor } from '@/app/(public)/s/[slug]/i18n/messages';

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const messages = await getPublicWebMessages('es');
  return (
    <NextIntlClientProvider locale={intlLocaleFor('es')} messages={messages}>
      <BookPageBody slug={slug} locale="es" />
    </NextIntlClientProvider>
  );
}
