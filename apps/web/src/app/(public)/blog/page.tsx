import Image from 'next/image';
import Link from 'next/link';

import type { Metadata } from 'next';

import {
  Breadcrumbs,
  CtaBand,
  DemoSection,
  JsonLd,
  breadcrumbLd,
} from '@/components/marketing/blocks';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { fetchPlatformBlogPosts, formatBlogDate } from '@/lib/marketing/blog';
import { ORGANIZATION_ID, SITE_URL } from '@/lib/marketing/site';

const TITLE = 'Blog sobre la gestión de trasteros y self-storage | TrasterOS';
const DESCRIPTION =
  'Guías para gestionar un negocio de trasteros: cómo montarlo, Veri*Factu, impagos, control de accesos, precios y captación de clientes.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/blog' },
  openGraph: {
    type: 'website',
    url: `${SITE_URL}/blog`,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'TrasterOS',
    locale: 'es_ES',
  },
};

const CRUMBS = [
  { name: 'Inicio', href: '/' },
  { name: 'Blog', href: '/blog' },
];

export default async function PlatformBlogPage() {
  const posts = await fetchPlatformBlogPosts();
  return (
    <>
      <PlatformAttribution />
      <JsonLd
        graph={[
          breadcrumbLd(CRUMBS),
          {
            '@type': 'Blog',
            '@id': `${SITE_URL}/blog#blog`,
            url: `${SITE_URL}/blog`,
            name: 'Blog de TrasterOS',
            inLanguage: 'es-ES',
            publisher: { '@id': ORGANIZATION_ID },
          },
        ]}
      />
      <section className="container py-12 md:py-16">
        <Breadcrumbs items={CRUMBS} />
        <div className="mx-auto mt-6 max-w-3xl text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-5xl">
            Guías para gestionar tu negocio de trasteros
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Cómo montarlo, cobrar sin perseguir a nadie, cumplir con Hacienda y llenar los
            trasteros.
          </p>
        </div>

        {posts.length === 0 ? (
          <p className="mt-12 text-center text-muted-foreground">
            Muy pronto publicaremos las primeras guías.
          </p>
        ) : (
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {posts.map((p) => (
              <Link
                key={p.slug}
                href={`/blog/${p.slug}`}
                className="group flex flex-col overflow-hidden rounded-2xl border bg-card transition-colors hover:border-primary"
              >
                {p.coverImageUrl && (
                  <div className="relative aspect-[16/9] w-full bg-muted">
                    <Image
                      src={p.coverImageUrl}
                      alt={p.coverImageAlt}
                      fill
                      sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
                      className="object-cover"
                    />
                  </div>
                )}
                <div className="flex flex-1 flex-col p-5">
                  <h2 className="text-lg font-semibold leading-snug group-hover:text-primary">
                    {p.title}
                  </h2>
                  {p.excerpt && (
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{p.excerpt}</p>
                  )}
                  <p className="mt-auto pt-4 text-xs text-muted-foreground">
                    {formatBlogDate(p.publishedAt)} · {p.readingMinutes} min de lectura
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}

        <div className="mt-12 rounded-2xl border bg-primary/5 p-6 text-center md:p-8">
          <p className="text-lg font-semibold">¿Cuánto puede darte tu local de trasteros?</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Calcula ingresos, beneficio y en cuánto recuperas la inversión.
          </p>
          <Link
            href="/calculadora-rentabilidad-trasteros"
            className="mt-4 inline-block font-medium text-primary underline underline-offset-2"
          >
            Abrir la calculadora de rentabilidad →
          </Link>
        </div>
      </section>
      <DemoSection place="blog" />
      <CtaBand />
    </>
  );
}
