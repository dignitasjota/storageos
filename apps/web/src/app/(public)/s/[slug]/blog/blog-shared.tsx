import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider, useTranslations } from 'next-intl';

import {
  blogHref,
  blogPostHref,
  getPublicWebMessages,
  intlLocaleFor,
  type PublicWebLocale,
} from '../i18n/messages';
import { siteUrl } from '../landing-shared';
import { TenantWebChrome } from '../tenant-web-chrome';

import type { PublicBlogListDto, PublicBlogPostDto } from '@storageos/shared';
import type { Metadata } from 'next';

import { MarkdownView } from '@/components/public/markdown-view';

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
 * `hreflang` de la entrada — SIEMPRE hacia la ruta de la plataforma
 * (`/s/<slug>/blog/<postSlug>`), nunca al dominio propio: el proxy de
 * dominio propio solo reescribe rutas de un segmento, así que `/blog/<post>`
 * (2 segmentos) todavía no resuelve ahí (pendiente de una regla dedicada).
 */
function postLanguageAlternates(slug: string, postSlug: string): Record<string, string> {
  const base = `/s/${slug}/blog/${postSlug}`;
  return {
    es: base,
    en: `/s/${slug}/l/en/blog/${postSlug}`,
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
  const base = `/s/${slug}/blog/${postSlug}`;
  const canonical = locale === 'en' ? `/s/${slug}/l/en/blog/${postSlug}` : base;
  return {
    title,
    description,
    alternates: { canonical, languages: postLanguageAlternates(slug, postSlug) },
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

/** `BlogPosting` + `BreadcrumbList` de la entrada. */
function buildBlogPostJsonLd(data: PublicBlogPostDto, slug: string, locale: PublicWebLocale) {
  const tenantBase = `${siteUrl()}/s/${slug}`;
  const orgId = `${tenantBase}/#organization`;
  const pageUrl = `${tenantBase}/blog/${data.post.slug}`;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': orgId, name: data.tenantName, url: tenantBase },
      {
        '@type': 'BlogPosting',
        '@id': `${pageUrl}#post`,
        mainEntityOfPage: pageUrl,
        headline: data.post.title,
        ...(data.post.coverImageUrl ? { image: [data.post.coverImageUrl] } : {}),
        datePublished: data.post.publishedAt,
        dateModified: data.post.updatedAt,
        author: { '@id': orgId },
        publisher: { '@id': orgId },
        inLanguage: intlLocaleFor(locale),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: data.tenantName, item: tenantBase },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: `${tenantBase}/blog` },
          { '@type': 'ListItem', position: 3, name: data.post.title, item: pageUrl },
        ],
      },
    ],
  };
}

function BlogListBody({
  data,
  slug,
  locale,
}: {
  data: PublicBlogListDto;
  slug: string;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.blog');
  const intlLocale = intlLocaleFor(locale);
  return (
    <TenantWebChrome data={data} locale={locale} languageHrefBuilder={(l) => blogHref(slug, l)}>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
        <p className="mt-2 text-muted-foreground">
          {t('subtitle', { tenantName: data.tenantName })}
        </p>

        {data.posts.length === 0 ? (
          <p className="mt-10 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="mt-8 space-y-8">
            {data.posts.map((post) => (
              <li key={post.slug} className="border-b pb-8 last:border-0">
                <Link
                  href={blogPostHref(slug, post.slug, locale)}
                  className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr]"
                >
                  {post.coverImageUrl ? (
                    <div className="relative aspect-video w-full overflow-hidden rounded-md border sm:aspect-square">
                      <Image
                        src={post.coverImageUrl}
                        alt=""
                        fill
                        loading="lazy"
                        sizes="160px"
                        className="object-cover"
                      />
                    </div>
                  ) : (
                    <div className="hidden sm:block" />
                  )}
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(post.publishedAt).toLocaleDateString(intlLocale, {
                        dateStyle: 'long',
                      })}
                    </p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight hover:underline">
                      {post.title}
                    </h2>
                    {post.excerpt && (
                      <p className="mt-2 text-sm text-muted-foreground">{post.excerpt}</p>
                    )}
                    <span className="mt-2 inline-block text-sm font-medium text-primary">
                      {t('readMore')} →
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </TenantWebChrome>
  );
}

function BlogPostBody({
  data,
  slug,
  postSlug,
  locale,
}: {
  data: PublicBlogPostDto;
  slug: string;
  postSlug: string;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.blog');
  const p = data.post;
  const jsonLd = buildBlogPostJsonLd(data, slug, locale);

  return (
    <TenantWebChrome
      data={data}
      locale={locale}
      languageHrefBuilder={(l) => blogPostHref(slug, postSlug, l)}
    >
      <article className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />

        <Link
          href={blogHref(slug, locale)}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('backToBlog')}
        </Link>

        <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{p.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('publishedOn', {
            date: new Date(p.publishedAt).toLocaleDateString(intlLocaleFor(locale), {
              dateStyle: 'long',
            }),
          })}
        </p>

        {p.coverImageUrl && (
          <div className="relative mt-6 aspect-video w-full overflow-hidden rounded-md border">
            <Image src={p.coverImageUrl} alt="" fill sizes="768px" className="object-cover" />
          </div>
        )}

        <div className="mt-8">
          <MarkdownView content={p.contentMarkdown} />
        </div>
      </article>
    </TenantWebChrome>
  );
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
