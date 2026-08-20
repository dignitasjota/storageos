import { notFound, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { BookPageBody } from '../../book-shared';

import {
  DEFAULT_PUBLIC_WEB_LOCALE,
  getPublicWebMessages,
  intlLocaleFor,
  isPublicWebLocale,
} from '@/app/(public)/s/[slug]/i18n/messages';

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
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <BookPageBody slug={slug} locale={locale} />
    </NextIntlClientProvider>
  );
}
