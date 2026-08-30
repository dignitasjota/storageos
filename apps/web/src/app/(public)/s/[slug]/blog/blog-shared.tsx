import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { getPublicWebMessages, intlLocaleFor, type PublicWebLocale } from '../i18n/messages';

import { BlogListBody, BlogPostBody } from './blog-body';

import type { PublicBlogListDto, PublicBlogPostDto } from '@storageos/shared';
import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function getBlogList(slug: string): Promise<PublicBlogListDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/blog`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicBlogListDto;
  } catch {
    return null;
  }
}

export async function getBlogPost(
  slug: string,
  postSlug: string,
): Promise<PublicBlogPostDto | null> {
  try {
    const res = await fetch(
      `${API_URL}/public/landing/${encodeURIComponent(slug)}/blog/${encodeURIComponent(postSlug)}`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicBlogPostDto;
  } catch {
    return null;
  }
}

/** `hreflang` alternates es/en + x-default para el listado del blog. */
function listLanguageAlternates(
  data: Pick<PublicBlogListDto, 'customDomain'>,
  slug: string,
): Record<string, string> {
  const base = data.customDomain ? `https://${data.customDomain}/blog` : `/s/${slug}/blog`;
  return {
    es: base,
    en: data.customDomain ? `https://${data.customDomain}/l/en/blog` : `/s/${slug}/l/en/blog`,
    'x-default': base,
  };
}

export async function buildBlogListMetadata(
  slug: string,
  locale: PublicWebLocale,
): Promise<Metadata> {
  const data = await getBlogList(slug);
  if (!data) {
    return {
      title: locale === 'en' ? 'Not found' : 'No encontrado',
      robots: { index: false },
    };
  }
  const title = `Blog · ${data.tenantName}`;
  const description =
    locale === 'en'
      ? `Storage tips and news from ${data.tenantName}.`
      : `Consejos y novedades sobre trasteros de ${data.tenantName}.`;
  // El listado es de UN solo segmento (`/blog`) → funciona bajo dominio propio
  // (el proxy de dominio propio reescribe rutas de un segmento).
  const base = data.customDomain ? `https://${data.customDomain}/blog` : `/s/${slug}/blog`;
  const canonical = locale === 'en' ? `${base.replace(/\/blog$/, '')}/l/en/blog` : base;
  return {
    title,
    description,
    alternates: { canonical, languages: listLanguageAlternates(data, slug) },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: data.tenantName,
      locale: locale === 'en' ? 'en_GB' : 'es_ES',
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/**
 * `hreflang` de la entrada, absolutos si hay dominio propio verificado (el
 * proxy de dominio propio reescribe `/blog/<postSlug>` — 2 segmentos).
 */
function postLanguageAlternates(
  data: Pick<PublicBlogPostDto, 'customDomain'>,
  slug: string,
  postSlug: string,
): Record<string, string> {
  const base = data.customDomain
    ? `https://${data.customDomain}/blog/${postSlug}`
    : `/s/${slug}/blog/${postSlug}`;
  return {
    es: base,
    en: data.customDomain
      ? `https://${data.customDomain}/l/en/blog/${postSlug}`
      : `/s/${slug}/l/en/blog/${postSlug}`,
    'x-default': base,
  };
}

export async function buildBlogPostMetadata(
  slug: string,
  postSlug: string,
  locale: PublicWebLocale,
): Promise<Metadata> {
  const data = await getBlogPost(slug, postSlug);
  if (!data) {
    return {
      title: locale === 'en' ? 'Not found' : 'No encontrado',
      robots: { index: false },
    };
  }
  const p = data.post;
  const title = p.seoTitle || `${p.title} · ${data.tenantName}`;
  const description = p.seoDescription || p.excerpt || `${p.title} · ${data.tenantName}`;
  const base = data.customDomain
    ? `https://${data.customDomain}/blog/${postSlug}`
    : `/s/${slug}/blog/${postSlug}`;
  const canonical =
    locale === 'en'
      ? data.customDomain
        ? `https://${data.customDomain}/l/en/blog/${postSlug}`
        : `/s/${slug}/l/en/blog/${postSlug}`
      : base;
  return {
    title,
    description,
    alternates: { canonical, languages: postLanguageAlternates(data, slug, postSlug) },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      type: 'article',
      siteName: data.tenantName,
      locale: locale === 'en' ? 'en_GB' : 'es_ES',
      ...(p.coverImageUrl ? { images: [{ url: p.coverImageUrl }] } : {}),
      publishedTime: p.publishedAt,
      modifiedTime: p.updatedAt,
    },
    twitter: {
      card: p.coverImageUrl ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  };
}

export async function BlogListPageBody({
  slug,
  locale,
}: {
  slug: string;
  locale: PublicWebLocale;
}) {
  const data = await getBlogList(slug);
  if (!data) notFound();
  const messages = await getPublicWebMessages(locale);
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <BlogListBody data={data} slug={slug} locale={locale} />
    </NextIntlClientProvider>
  );
}

export async function BlogPostPageBody({
  slug,
  postSlug,
  locale,
}: {
  slug: string;
  postSlug: string;
  locale: PublicWebLocale;
}) {
  const data = await getBlogPost(slug, postSlug);
  if (!data) notFound();
  const messages = await getPublicWebMessages(locale);
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <BlogPostBody data={data} slug={slug} postSlug={postSlug} locale={locale} />
    </NextIntlClientProvider>
  );
}
