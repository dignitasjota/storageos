import { NextIntlClientProvider } from 'next-intl';

import { brandOf, getContractSignView } from './get-sign-view';
import { SignPageBody } from './sign-shared';

import {
  getPublicWebMessages,
  intlLocaleFor,
  signHref,
} from '@/app/(public)/s/[slug]/i18n/messages';
import { TenantWebChrome } from '@/app/(public)/s/[slug]/tenant-web-chrome';

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const messages = await getPublicWebMessages('es');
  const { data, error } = await getContractSignView(token, 'es');
  return (
    <NextIntlClientProvider locale={intlLocaleFor('es')} messages={messages}>
      {data ? (
        <TenantWebChrome
          data={brandOf(data)}
          locale="es"
          googleAnalyticsId={data.googleAnalyticsId}
          languageHrefBuilder={(l) => signHref(token, l)}
        >
          <SignPageBody token={token} locale="es" initialView={data} />
        </TenantWebChrome>
      ) : (
        <SignPageBody token={token} locale="es" initialError={error} />
      )}
    </NextIntlClientProvider>
  );
}
