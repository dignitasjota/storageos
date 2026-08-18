import { buildLandingMetadata, LandingPageBody } from './landing-shared';

import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildLandingMetadata(slug, 'es');
}

export default async function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <LandingPageBody slug={slug} locale="es" />;
}
