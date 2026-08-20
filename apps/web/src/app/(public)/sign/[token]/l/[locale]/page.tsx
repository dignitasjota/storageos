import { notFound, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { SignPageBody } from '../../sign-shared';

import {
  DEFAULT_PUBLIC_WEB_LOCALE,
  getPublicWebMessages,
  intlLocaleFor,
  isPublicWebLocale,
} from '@/app/(public)/s/[slug]/i18n/messages';

export default async function SignLocalePage({
  params,
}: {
  params: Promise<{ token: string; locale: string }>;
}) {
  const { token, locale } = await params;
  if (!isPublicWebLocale(locale)) notFound();
  // El idioma por defecto ya vive en la ruta desnuda `/sign/[token]` — evita
  // contenido duplicado indexable en `/l/es`.
  if (locale === DEFAULT_PUBLIC_WEB_LOCALE) redirect(`/sign/${token}`);
  const messages = await getPublicWebMessages(locale);
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <SignPageBody token={token} locale={locale} />
    </NextIntlClientProvider>
  );
}
