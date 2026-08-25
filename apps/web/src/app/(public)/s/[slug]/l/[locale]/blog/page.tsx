import { notFound, redirect } from 'next/navigation';

import { BlogListPageBody, buildBlogListMetadata } from '../../../blog/blog-shared';
import { DEFAULT_PUBLIC_WEB_LOCALE, isPublicWebLocale } from '../../../i18n/messages';

import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { slug, locale } = await params;
  if (!isPublicWebLocale(locale)) return { robots: { index: false } };
  return buildBlogListMetadata(slug, locale);
}

export default async function BlogListLocalePage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}) {
  const { slug, locale } = await params;
  if (!isPublicWebLocale(locale)) notFound();
  // El idioma por defecto ya vive en la ruta desnuda `/s/[slug]/blog` — evita
  // contenido duplicado indexable en `/l/es/blog`.
  if (locale === DEFAULT_PUBLIC_WEB_LOCALE) redirect(`/s/${slug}/blog`);
  return <BlogListPageBody slug={slug} locale={locale} />;
}
