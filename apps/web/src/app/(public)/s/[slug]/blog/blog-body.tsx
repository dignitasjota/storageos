'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  blogHref,
  blogPostHref,
  facilityHref,
  intlLocaleFor,
  type PublicWebLocale,
} from '../i18n/messages';
import { siteUrl } from '../landing-shared';

import type {
  PublicBlogFacilityLinkDto,
  PublicBlogListDto,
  PublicBlogPostDto,
} from '@storageos/shared';

import { MarkdownView } from '@/components/public/markdown-view';

/** `BlogPosting` + `BreadcrumbList` de la entrada. */
function buildBlogPostJsonLd(data: PublicBlogPostDto, slug: string, locale: PublicWebLocale) {
  const tenantBase = data.customDomain ? `https://${data.customDomain}` : `${siteUrl()}/s/${slug}`;
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

/**
 * Enlazado interno del blog → páginas de local (SEO: pasa autoridad de las
 * entradas, que suelen atraer tráfico long-tail, a las páginas que
 * convierten). Se omite si el tenant no tiene locales enlazables.
 */
function RelatedFacilities({
  facilities,
  slug,
  locale,
}: {
  facilities: PublicBlogFacilityLinkDto[];
  slug: string;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.blog');
  const tCommon = useTranslations('publicWeb.common');
  if (facilities.length === 0) return null;
  return (
    <div className="mt-12 border-t pt-8">
      <h2 className="text-lg font-semibold tracking-tight">{t('relatedFacilitiesTitle')}</h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {facilities.map((f) => (
          <li key={f.publicSlug}>
            <Link
              href={facilityHref(slug, f.publicSlug, locale)}
              className="block rounded-md border p-3 hover:border-primary hover:bg-muted/40"
            >
              <span className="font-medium">{f.name}</span>
              {f.city && <span className="text-muted-foreground"> · {f.city}</span>}
              {f.fromPriceMonthly != null && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {tCommon('from')} {f.fromPriceMonthly.toLocaleString(intlLocaleFor(locale))}{' '}
                  {tCommon('perMonthVatIncl')}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BlogListBody({
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
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
      <p className="mt-2 text-muted-foreground">{t('subtitle', { tenantName: data.tenantName })}</p>

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

      <RelatedFacilities facilities={data.facilities} slug={slug} locale={locale} />
    </div>
  );
}

export function BlogPostBody({
  data,
  slug,
  locale,
}: {
  data: PublicBlogPostDto;
  slug: string;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.blog');
  const p = data.post;
  const jsonLd = buildBlogPostJsonLd(data, slug, locale);

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link href={blogHref(slug, locale)} className="text-sm text-muted-foreground hover:underline">
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

      <RelatedFacilities facilities={data.facilities} slug={slug} locale={locale} />
    </article>
  );
}
