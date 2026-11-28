import { BlogListPageBody, buildBlogListMetadata } from './blog-shared';

import type { Metadata } from 'next';

import { isTenantSubdomainRequest } from '@/lib/seo/tenant-subdomain-request';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildBlogListMetadata(slug, 'es', await isTenantSubdomainRequest());
}

export default async function BlogListPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <BlogListPageBody slug={slug} locale="es" />;
}
