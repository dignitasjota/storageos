import type { Metadata } from 'next';

import { LegalPage, formatLegalDate } from '@/components/public/legal-ui';
import { MarkdownView } from '@/components/public/markdown-view';
import { fetchLegalDoc } from '@/lib/legal';

export const metadata: Metadata = {
  alternates: { canonical: '/eliminar-datos' },
  title: 'Eliminación de datos',
  description:
    'Cómo pedir que se eliminen tus datos personales tratados con TrasterOS, incluidas las conversaciones de WhatsApp con las empresas que usan la plataforma.',
};

export default async function DataDeletionPage() {
  const doc = await fetchLegalDoc('data-deletion');
  return (
    <LegalPage title={doc.title} lastUpdated={formatLegalDate(doc.updatedAt)}>
      <MarkdownView content={doc.content} />
    </LegalPage>
  );
}
