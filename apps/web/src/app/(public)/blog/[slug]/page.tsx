import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { Metadata } from 'next';

import { ArticleMarkdown } from '@/components/marketing/article-markdown';
import {
  Breadcrumbs,
  CtaBand,
  CtaButtons,
  DemoSection,
  JsonLd,
  breadcrumbLd,
} from '@/components/marketing/blocks';
import { StickyMobileCta } from '@/components/marketing/sticky-cta';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { fetchPlatformBlogPost, formatBlogDate } from '@/lib/marketing/blog';
import { ORGANIZATION_ID, SITE_URL } from '@/lib/marketing/site';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const post = await fetchPlatformBlogPost((await params).slug);
  if (!post) return { title: 'No encontrado', robots: { index: false } };
  const title = post.seoTitle || `${post.title} | TrasterOS`;
  const description = post.seoDescription || post.excerpt || undefined;
  const url = `${SITE_URL}/blog/${post.slug}`;
  return {
    title: { absolute: title },
    ...(description ? { description } : {}),
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: 'article',
      url,
      title,
      ...(description ? { description } : {}),
      siteName: 'TrasterOS',
      locale: 'es_ES',
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      ...(post.coverImageUrl
        ? { images: [{ url: post.coverImageUrl, alt: post.coverImageAlt }] }
        : {}),
    },
    twitter: { card: 'summary_large_image', title, ...(description ? { description } : {}) },
  };
}

export default async function PlatformBlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const post = await fetchPlatformBlogPost((await params).slug);
  if (!post) notFound();
  const url = `${SITE_URL}/blog/${post.slug}`;
  const crumbs = [
    { name: 'Inicio', href: '/' },
    { name: 'Blog', href: '/blog' },
    { name: post.title, href: `/blog/${post.slug}` },
  ];

  return (
    <>
      <PlatformAttribution />
      <JsonLd
        graph={[
          breadcrumbLd(crumbs),
          {
            '@type': 'BlogPosting',
            '@id': `${url}#article`,
            mainEntityOfPage: url,
            headline: post.title,
            ...(post.excerpt ? { description: post.excerpt } : {}),
            ...(post.coverImageUrl ? { image: [post.coverImageUrl] } : {}),
            datePublished: post.publishedAt,
            dateModified: post.updatedAt,
            inLanguage: 'es-ES',
            author: { '@id': ORGANIZATION_ID },
            publisher: { '@id': ORGANIZATION_ID },
            isPartOf: { '@id': `${SITE_URL}/blog#blog` },
          },
        ]}
      />
      <article className="container max-w-3xl py-12 md:py-16">
        <Breadcrumbs items={crumbs} />
        <header className="mt-6">
          <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {post.title}
          </h1>
          {post.excerpt && <p className="mt-4 text-lg text-muted-foreground">{post.excerpt}</p>}
          <p className="mt-4 text-sm text-muted-foreground">
            <time dateTime={post.publishedAt}>{formatBlogDate(post.publishedAt)}</time> ·{' '}
            {post.readingMinutes} min de lectura
          </p>
        </header>
        {post.coverImageUrl && (
          <div className="relative mt-8 aspect-[16/9] w-full overflow-hidden rounded-2xl border bg-muted">
            <Image
              src={post.coverImageUrl}
              alt={post.coverImageAlt}
              fill
              priority
              sizes="(min-width: 768px) 768px, 100vw"
              className="object-cover"
            />
          </div>
        )}
        <div className="mt-10">
          <ArticleMarkdown content={post.contentMarkdown} />
        </div>

        <aside className="mt-12 rounded-2xl border bg-primary/5 p-6 md:p-8">
          <p className="text-lg font-semibold">Gestiona tus trasteros con TrasterOS</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Reserva online, contratos con firma electrónica, cobros automáticos, control de accesos
            y facturación Veri*Factu en un solo programa.
          </p>
          <div className="mt-5">
            <CtaButtons />
          </div>
        </aside>
      </article>

      {post.related.length > 0 && (
        <section className="container max-w-5xl pb-12" aria-labelledby="related-title">
          <h2 id="related-title" className="mb-6 text-xl font-semibold tracking-tight">
            Sigue leyendo
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {post.related.map((r) => (
              <Link
                key={r.slug}
                href={`/blog/${r.slug}`}
                className="rounded-2xl border bg-card p-5 transition-colors hover:border-primary"
              >
                <p className="font-semibold leading-snug">{r.title}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {formatBlogDate(r.publishedAt)} · {r.readingMinutes} min
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
      <DemoSection place="articulo" />
      <CtaBand />
      <StickyMobileCta />
    </>
  );
}
