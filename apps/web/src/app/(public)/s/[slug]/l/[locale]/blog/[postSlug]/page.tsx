import { notFound, redirect } from 'next/navigation';

import { BlogPostPageBody, buildBlogPostMetadata } from '../../../../blog/blog-shared';
import { DEFAULT_PUBLIC_WEB_LOCALE, isPublicWebLocale } from '../../../../i18n/messages';

import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string; postSlug: string }>;
}): Promise<Metadata> {
  const { slug, locale, postSlug } = await params;
  if (!isPublicWebLocale(locale)) return { robots: { index: false } };
  return buildBlogPostMetadata(slug, postSlug, locale);
}

export default async function BlogPostLocalePage({
  params,
}: {
  params: Promise<{ slug: string; locale: string; postSlug: string }>;
}) {
  const { slug, locale, postSlug } = await params;
  if (!isPublicWebLocale(locale)) notFound();
  // El idioma por defecto ya vive en la ruta desnuda — evita contenido
  // duplicado indexable en `/l/es/blog/<postSlug>`.
  if (locale === DEFAULT_PUBLIC_WEB_LOCALE) redirect(`/s/${slug}/blog/${postSlug}`);
  return <BlogPostPageBody slug={slug} postSlug={postSlug} locale={locale} />;
}
