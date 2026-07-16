import type { Metadata } from 'next';

import { LegalPage, formatLegalDate } from '@/components/public/legal-ui';
import { MarkdownView } from '@/components/public/markdown-view';
import { fetchLegalDoc } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Términos y Condiciones · TrasterOS',
  description:
    'Condiciones de uso del servicio TrasterOS: objeto, cuenta, planes y pagos, obligaciones, responsabilidad, cancelación, protección de datos y ley aplicable.',
};

export default async function TermsPage() {
  const doc = await fetchLegalDoc('terms');
  return (
    <LegalPage title={doc.title} lastUpdated={formatLegalDate(doc.updatedAt)}>
      <MarkdownView content={doc.content} />
    </LegalPage>
  );
}
