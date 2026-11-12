import { notFound } from 'next/navigation';

import type { Metadata } from 'next';

import { MarketingPageView, marketingMetadata } from '@/components/marketing/marketing-page';
import { FEATURE_PAGES, findMarketingPage } from '@/lib/marketing/pages';

export function generateStaticParams() {
  return FEATURE_PAGES.map((p) => ({ slug: p.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const page = findMarketingPage('feature', (await params).slug);
  return page ? marketingMetadata(page) : {};
}

export default async function FeaturePage({ params }: { params: Promise<{ slug: string }> }) {
  const page = findMarketingPage('feature', (await params).slug);
  if (!page) notFound();
  return <MarketingPageView page={page} />;
}
