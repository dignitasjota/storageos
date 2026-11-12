import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';

import type { Metadata } from 'next';

import {
  Breadcrumbs,
  CtaBand,
  CtaButtons,
  DemoSection,
  FaqList,
  JsonLd,
  ProductShot,
  breadcrumbLd,
  faqPageLd,
} from '@/components/marketing/blocks';
import { StickyMobileCta } from '@/components/marketing/sticky-cta';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { marketingPageHref, relatedPages, type MarketingPage } from '@/lib/marketing/pages';
import { ORGANIZATION_ID, SITE_URL } from '@/lib/marketing/site';

export function marketingMetadata(page: MarketingPage): Metadata {
  const path = marketingPageHref(page);
  return {
    title: { absolute: page.metaTitle },
    description: page.metaDescription,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      url: `${SITE_URL}${path}`,
      title: page.metaTitle,
      description: page.metaDescription,
      siteName: 'TrasterOS',
      locale: 'es_ES',
    },
    twitter: {
      card: 'summary_large_image',
      title: page.metaTitle,
      description: page.metaDescription,
    },
  };
}

/** Página de una funcionalidad o de un tipo de cliente. */
export function MarketingPageView({ page }: { page: MarketingPage }) {
  const path = marketingPageHref(page);
  const crumbs = [
    { name: 'Inicio', href: '/' },
    page.kind === 'feature'
      ? { name: 'Funcionalidades', href: '/funcionalidades' }
      : { name: 'Soluciones', href: '/soluciones' },
    { name: page.navTitle, href: path },
  ];
  const related = relatedPages(page);
  const url = `${SITE_URL}${path}`;

  return (
    <>
      <PlatformAttribution />
      <JsonLd
        graph={[
          {
            '@type': 'WebPage',
            '@id': `${url}#webpage`,
            url,
            name: page.metaTitle,
            description: page.metaDescription,
            inLanguage: 'es-ES',
            isPartOf: { '@id': `${SITE_URL}/#website` },
            publisher: { '@id': ORGANIZATION_ID },
            about: { '@id': `${SITE_URL}/#software` },
          },
          breadcrumbLd(crumbs),
          faqPageLd(page.faqs, url),
        ]}
      />

      <section className="container py-12 md:py-16">
        <Breadcrumbs items={crumbs} />
        <div
          className={`mt-6 grid items-center gap-10 ${page.shot ? 'lg:grid-cols-[1.05fr_1fr]' : ''}`}
        >
          <div className={page.shot ? '' : 'mx-auto max-w-3xl text-center'}>
            <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-5xl">
              {page.h1}
            </h1>
            <p className="mt-4 text-pretty text-lg text-muted-foreground">{page.lead}</p>
            <ul
              className={`mt-6 grid gap-2 text-sm sm:grid-cols-2 ${page.shot ? '' : 'mx-auto max-w-2xl text-left'}`}
            >
              {page.highlights.map((h) => (
                <li key={h} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <CtaButtons center={!page.shot} />
            </div>
          </div>
          {page.shot && <ProductShot shot={page.shot} priority />}
        </div>
      </section>

      <div className="container space-y-6 pb-8">
        {page.sections.map((s, i) => (
          <section
            key={s.title}
            className={`grid gap-6 rounded-2xl border p-6 md:grid-cols-[1fr_1.2fr] md:p-10 ${i % 2 === 0 ? 'bg-card' : 'bg-muted/30'}`}
          >
            <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{s.title}</h2>
            <div>
              <p className="leading-relaxed text-muted-foreground">{s.text}</p>
              {s.points && (
                <ul className="mt-4 space-y-2 text-sm">
                  {s.points.map((p) => (
                    <li key={p} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ))}
      </div>

      <section className="container py-12" aria-labelledby="faq-title">
        <div className="mx-auto max-w-3xl">
          <h2 id="faq-title" className="mb-6 text-center text-2xl font-semibold tracking-tight">
            Preguntas frecuentes
          </h2>
          <FaqList items={page.faqs} />
        </div>
      </section>

      {related.length > 0 && (
        <section className="container pb-8" aria-labelledby="related-title">
          <h2 id="related-title" className="mb-6 text-xl font-semibold tracking-tight">
            También te puede interesar
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {related.map((r) => (
              <Link
                key={r.slug}
                href={marketingPageHref(r)}
                className="group rounded-2xl border bg-card p-5 transition-colors hover:border-primary"
              >
                <p className="font-semibold">{r.navTitle}</p>
                <p className="mt-1 text-sm text-muted-foreground">{r.summary}</p>
                <span className="mt-3 inline-flex items-center text-sm font-medium text-primary">
                  Ver más
                  <ArrowRight
                    className="ml-1 size-4 transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <DemoSection place={page.slug} />
      <CtaBand />
      <StickyMobileCta />
    </>
  );
}

/** Rejilla de enlaces a varias páginas (índices de funcionalidades y soluciones). */
export function MarketingPageGrid({ pages }: { pages: MarketingPage[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {pages.map((p) => (
        <Link
          key={p.slug}
          href={marketingPageHref(p)}
          className="group rounded-2xl border bg-card p-6 transition-colors hover:border-primary"
        >
          <h2 className="text-lg font-semibold">{p.navTitle}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{p.summary}</p>
          <span className="mt-4 inline-flex items-center text-sm font-medium text-primary">
            Ver más
            <ArrowRight
              className="ml-1 size-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden
            />
          </span>
        </Link>
      ))}
    </div>
  );
}
