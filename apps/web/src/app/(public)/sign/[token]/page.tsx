import { NextIntlClientProvider } from 'next-intl';

import { SignPageBody } from './sign-shared';

import { getPublicWebMessages, intlLocaleFor } from '@/app/(public)/s/[slug]/i18n/messages';

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const messages = await getPublicWebMessages('es');
  return (
    <NextIntlClientProvider locale={intlLocaleFor('es')} messages={messages}>
      <SignPageBody token={token} locale="es" />
    </NextIntlClientProvider>
  );
}
