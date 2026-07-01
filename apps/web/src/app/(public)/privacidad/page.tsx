import type { Metadata } from 'next';

import { LegalPage, formatLegalDate } from '@/components/public/legal-ui';
import { MarkdownView } from '@/components/public/markdown-view';
import { fetchLegalDoc } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Política de Privacidad · StorageOS',
  description:
    'Cómo StorageOS trata los datos personales conforme al RGPD y la LOPDGDD: responsable, finalidades, base jurídica, encargados, derechos y contacto.',
};

export default async function PrivacyPage() {
  const doc = await fetchLegalDoc('privacy');
  return (
    <LegalPage title={doc.title} lastUpdated={formatLegalDate(doc.updatedAt)}>
      <MarkdownView content={doc.content} />
    </LegalPage>
  );
}
