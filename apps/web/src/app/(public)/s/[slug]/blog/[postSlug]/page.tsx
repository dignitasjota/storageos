import { BlogPostPageBody, buildBlogPostMetadata } from '../blog-shared';

import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; postSlug: string }>;
}): Promise<Metadata> {
  const { slug, postSlug } = await params;
  return buildBlogPostMetadata(slug, postSlug, 'es');
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string; postSlug: string }>;
}) {
  const { slug, postSlug } = await params;
  return <BlogPostPageBody slug={slug} postSlug={postSlug} locale="es" />;
}
