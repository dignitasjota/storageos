import { buildLegalMetadata, LegalPageBody } from '../legal-shared';

import type { Metadata } from 'next';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  return buildLegalMetadata(slug, 'cookies');
}

export default async function Page({ params }: Params) {
  const { slug } = await params;
  return <LegalPageBody slug={slug} doc="cookies" />;
}
