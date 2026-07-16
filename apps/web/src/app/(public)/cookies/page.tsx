import type { Metadata } from 'next';

import { LegalPage, formatLegalDate } from '@/components/public/legal-ui';
import { MarkdownView } from '@/components/public/markdown-view';
import { fetchLegalDoc } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Política de Cookies · TrasterOS',
  description:
    'Qué cookies y tecnologías equivalentes utiliza TrasterOS, su finalidad, base jurídica y cómo gestionarlas.',
};

export default async function CookiesPage() {
  const doc = await fetchLegalDoc('cookies');
  return (
    <LegalPage title={doc.title} lastUpdated={formatLegalDate(doc.updatedAt)}>
      <MarkdownView content={doc.content} />
    </LegalPage>
  );
}
