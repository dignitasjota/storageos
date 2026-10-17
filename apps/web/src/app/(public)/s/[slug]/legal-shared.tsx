import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { getPublicWebMessages, intlLocaleFor, legalHref } from './i18n/messages';
import { TenantWebChrome } from './tenant-web-chrome';

import type { PublicLegalDocDto, TenantLegalDoc } from '@storageos/shared';
import type { Metadata } from 'next';

import { MarkdownView } from '@/components/public/markdown-view';
import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

async function getLegalDoc(slug: string, doc: TenantLegalDoc): Promise<PublicLegalDocDto | null> {
  try {
    const res = await fetch(
      `${SERVER_API_URL}/public/landing/${encodeURIComponent(slug)}/legal/${doc}`,
      { headers: internalApiHeaders(), next: { revalidate: 300 } },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicLegalDocDto;
  } catch {
    return null;
  }
}

export async function buildLegalMetadata(slug: string, doc: TenantLegalDoc): Promise<Metadata> {
  const data = await getLegalDoc(slug, doc);
  if (!data) return { title: 'No encontrado', robots: { index: false } };
  const title = `${data.title} · ${data.tenantName}`;
  return {
    title: { absolute: title },
    alternates: { canonical: legalHref(slug, doc, data.customDomain) },
    // Páginas de obligado cumplimiento: se pueden seguir, no hace falta indexarlas.
    robots: { index: false, follow: true },
  };
}

/** Aviso legal, privacidad o cookies de la web del tenant (con su marco). */
export async function LegalPageBody({ slug, doc }: { slug: string; doc: TenantLegalDoc }) {
  const data = await getLegalDoc(slug, doc);
  if (!data) notFound();
  const messages = await getPublicWebMessages('es');
  return (
    <NextIntlClientProvider locale={intlLocaleFor('es')} messages={messages}>
      <TenantWebChrome data={data} locale="es" googleAnalyticsId={data.googleAnalyticsId}>
        <article className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
          <h1 className="mb-8 text-3xl font-bold tracking-tight">{data.title}</h1>
          <MarkdownView content={data.markdown} />
        </article>
      </TenantWebChrome>
    </NextIntlClientProvider>
  );
}
