import { ArrowRight, ChevronDown, Quote } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

import type { PlatformTestimonialInput } from '@storageos/shared';
import type { ReactNode } from 'react';

import { DemoForm } from '@/components/marketing/demo-form';
import { Button } from '@/components/ui/button';
import { safeJsonLd } from '@/lib/json-ld';
import { SCREENSHOTS, type ScreenshotKey } from '@/lib/marketing/pages';
import { SITE_URL } from '@/lib/marketing/site';

/**
 * Piezas de las páginas de la web de TrasterOS (portada, funcionalidades,
 * soluciones, precios, blog). Componentes de servidor salvo el formulario.
 */

/** Los dos botones de siempre: probar gratis y pedir una demo. */
export function CtaButtons({
  center = false,
  demoHref = '#demo',
}: {
  center?: boolean;
  demoHref?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${center ? 'justify-center' : ''}`}>
      <Button asChild size="lg">
        <Link href="/register">
          Probar 30 días gratis
          <ArrowRight className="ml-2 size-4" aria-hidden />
        </Link>
      </Button>
      <Button asChild size="lg" variant="outline">
        <Link href={demoHref}>Pedir una demo</Link>
      </Button>
    </div>
  );
}

/** Captura del producto: en un marco de navegador o, si es del móvil, de teléfono. */
export function ProductShot({
  shot,
  priority = false,
  className = '',
}: {
  shot: ScreenshotKey;
  priority?: boolean;
  className?: string;
}) {
  const s = SCREENSHOTS[shot];
  if (s.mobile) {
    return (
      <div
        className={`mx-auto w-[260px] rounded-[2.2rem] border-[10px] border-slate-900 bg-slate-900 shadow-2xl ${className}`}
      >
        <Image
          src={s.src}
          alt={s.alt}
          width={390}
          height={664}
          sizes="260px"
          className="h-auto w-full rounded-[1.6rem]"
          {...(priority ? { priority: true } : {})}
        />
      </div>
    );
  }
  return (
    <div className={`overflow-hidden rounded-xl border bg-card shadow-2xl ${className}`}>
      <div className="flex items-center gap-1.5 border-b bg-muted/60 px-3 py-2" aria-hidden>
        <span className="size-2.5 rounded-full bg-red-400" />
        <span className="size-2.5 rounded-full bg-amber-400" />
        <span className="size-2.5 rounded-full bg-emerald-400" />
      </div>
      <Image
        src={s.src}
        alt={s.alt}
        width={1440}
        height={900}
        sizes="(min-width: 1024px) 960px, 100vw"
        className="h-auto w-full"
        {...(priority ? { priority: true } : {})}
      />
    </div>
  );
}

/** Preguntas desplegables (el texto está en la página aunque estén cerradas). */
export function FaqList({ items }: { items: { q: string; a: string }[] }) {
  return (
    <div className="divide-y divide-border rounded-2xl border bg-card">
      {items.map((item) => (
        <details key={item.q} className="group p-5 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-semibold">
            <h3 className="text-base">{item.q}</h3>
            <ChevronDown
              className="mt-0.5 size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
        </details>
      ))}
    </div>
  );
}

/** `FAQPage` con las mismas preguntas que se ven. */
export function faqPageLd(items: { q: string; a: string }[], url: string) {
  return {
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** Miga de pan visible + `BreadcrumbList`. */
export function Breadcrumbs({ items }: { items: { name: string; href: string }[] }) {
  return (
    <nav aria-label="Miga de pan" className="text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => (
          <li key={item.href} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>/</span>}
            {i === items.length - 1 ? (
              <span aria-current="page" className="text-foreground">
                {item.name}
              </span>
            ) : (
              <Link href={item.href} className="hover:text-foreground">
                {item.name}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function breadcrumbLd(items: { name: string; href: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.href === '/' ? '/' : item.href}`,
    })),
  };
}

export function JsonLd({ graph }: { graph: unknown[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: safeJsonLd({ '@context': 'https://schema.org', '@graph': graph }),
      }}
    />
  );
}

/** Bloque «Pide una demo» con el formulario (ancla `#demo`). */
export function DemoSection({
  place,
  title = 'Te lo enseñamos con tus casos',
  subtitle = 'Cuéntanos cómo trabajas y te enseñamos cómo lo harías con TrasterOS: reservas, contratos, cobros, accesos y facturación.',
}: {
  place: string;
  title?: string;
  subtitle?: string;
}) {
  return (
    <section id="demo" className="container scroll-mt-20 py-16" aria-labelledby={`demo-${place}`}>
      <div className="mx-auto grid max-w-5xl items-center gap-8 lg:grid-cols-2">
        <div>
          <h2 id={`demo-${place}`} className="text-2xl font-semibold tracking-tight md:text-3xl">
            {title}
          </h2>
          <p className="mt-3 text-muted-foreground">{subtitle}</p>
          <ul className="mt-6 space-y-2 text-sm">
            <li>✓ Te ayudamos a importar tus inquilinos, trasteros y contratos</li>
            <li>✓ Resolvemos tus dudas sobre Veri*Factu, cobros y accesos</li>
            <li>✓ Sin compromiso: si prefieres, pruébalo tú 30 días gratis</li>
          </ul>
        </div>
        <DemoForm place={place} />
      </div>
    </section>
  );
}

/** Testimonios de clientes (solo los que hay guardados en el panel). */
export function Testimonials({ items }: { items: PlatformTestimonialInput[] }) {
  if (items.length === 0) return null;
  return (
    <section className="container py-16" aria-labelledby="testimonials-title">
      <h2
        id="testimonials-title"
        className="mb-10 text-center text-2xl font-semibold tracking-tight md:text-3xl"
      >
        Lo que dicen nuestros clientes
      </h2>
      <div
        className={`mx-auto grid gap-4 ${items.length === 1 ? 'max-w-2xl' : 'max-w-5xl md:grid-cols-2'} ${items.length > 2 ? 'lg:grid-cols-3' : ''}`}
      >
        {items.map((t) => (
          <figure
            key={`${t.name}-${t.quote.slice(0, 20)}`}
            className="rounded-2xl border bg-card p-6"
          >
            <Quote className="size-6 text-primary" aria-hidden />
            <blockquote className="mt-3 text-pretty leading-relaxed">{t.quote}</blockquote>
            <figcaption className="mt-4 text-sm">
              <span className="font-semibold">{t.name}</span>
              {(t.role || t.business) && (
                <span className="text-muted-foreground">
                  {' · '}
                  {[t.role, t.business].filter(Boolean).join(', ')}
                </span>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/** Banda final de llamada a la acción. */
export function CtaBand({
  title = 'Empieza a gestionar tus trasteros hoy',
  subtitle = 'Prueba 30 días gratis, sin tarjeta ni permanencia. Te ayudamos a importar tus datos.',
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <section className="container pb-20 pt-4">
      <div className="rounded-3xl bg-primary px-6 py-12 text-center text-primary-foreground md:px-12">
        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h2>
        <p className="mx-auto mt-3 max-w-xl text-primary-foreground/85">{subtitle}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg" variant="secondary">
            <Link href="/register">
              Probar 30 días gratis
              <ArrowRight className="ml-2 size-4" aria-hidden />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="border-primary-foreground/40 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
          >
            <Link href="#demo">Pedir una demo</Link>
          </Button>
        </div>
        {children}
      </div>
    </section>
  );
}
