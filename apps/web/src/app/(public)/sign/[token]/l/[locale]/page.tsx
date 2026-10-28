import { notFound, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { brandOf, getContractSignView } from '../../get-sign-view';
import { SignPageBody } from '../../sign-shared';

import {
  DEFAULT_PUBLIC_WEB_LOCALE,
  getPublicWebMessages,
  intlLocaleFor,
  isPublicWebLocale,
  signHref,
} from '@/app/(public)/s/[slug]/i18n/messages';
import { TenantSiteChrome } from '@/app/(public)/s/[slug]/tenant-site-chrome';

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
  const { data, error } = await getContractSignView(token, locale);
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      {data ? (
        <TenantSiteChrome
          slug={data.tenantSlug}
          fallback={brandOf(data)}
          locale={locale}
          googleAnalyticsId={data.googleAnalyticsId}
          languageHrefBuilder={(l) => signHref(token, l)}
        >
          <SignPageBody token={token} locale={locale} initialView={data} />
        </TenantSiteChrome>
      ) : (
        <SignPageBody token={token} locale={locale} initialError={error} />
      )}
    </NextIntlClientProvider>
  );
}
