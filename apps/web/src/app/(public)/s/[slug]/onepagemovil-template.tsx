'use client';

import {
  CalendarCheck,
  Cctv,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Menu,
  MonitorSmartphone,
  Phone,
  Star,
  Truck,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { ContactForm } from './contact-form';
import { GoogleAnalyticsScript, trackEvent } from './google-analytics';
import {
  blogHref as buildBlogHref,
  blogPostHref as buildBlogPostHref,
  bookHref as buildBookHref,
  facilityHref as buildFacilityHref,
  intlLocaleFor,
  type PublicWebLocale,
} from './i18n/messages';
import { StorageCalculator } from './storage-calculator';
import {
  cities,
  formatPrice,
  GoogleReviewBadge,
  OpeningHoursInfo,
  PromoBanner,
  useHeadlineFallback,
  WhatsAppButton,
} from './templates';

import type { PublicLandingDto } from '@storageos/shared';
import type { LucideIcon } from 'lucide-react';

const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';

/** Iconos fijos por posición (el tenant edita el texto, no el icono). */
const ADVANTAGE_ICONS: LucideIcon[] = [MonitorSmartphone, CalendarCheck, Cctv, Truck];

type FaqItem = { question: string; answer: string };
type UseItem = { title: string; points: string[] };

interface UnitCard {
  key: string;
  facilityId: string;
  facilityName: string;
  city: string | null;
  unitTypeId: string;
  name: string;
  areaM2: number | null;
  price: number;
  available: number;
}

/**
 * Plantilla premium «OnePageMovil»: web de una página pensada para el móvil.
 * Portada con foto, ventajas, centros, carrusel de trasteros con precio, usos,
 * pasos, calculadora, opiniones con galería, preguntas, blog y contacto, con
 * una barra fija abajo («Llamar» / «Alquilar ya») en el móvil. Autocontenida
 * (cabecera y pie propios), como Onepage/Escaparate/Corporativa.
 */
export function OnePageMovilTemplate({
  data,
  locale,
}: {
  data: PublicLandingDto;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.onepagemovil');
  const tCommon = useTranslations('publicWeb.common');
  const tChrome = useTranslations('publicWeb.chrome');
  const tTestimonials = useTranslations('publicWeb.testimonials');
  const tFaq = useTranslations('publicWeb.faq');
  const tBlog = useTranslations('publicWeb.blog');

  const brand = data.brandColor ?? '#2563EB';
  const where = cities(data);
  const headlineFallback = useHeadlineFallback(where);
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const bookHref = buildBookHref(data.tenantSlug, locale);
  const blogHref = data.hasBlog
    ? buildBlogHref(data.tenantSlug, locale, data.customDomain)
    : undefined;
  const images = data.facilities.flatMap((f) => f.imageUrls);
  const heroImage = images[0] ?? null;
  const phone = data.facilities.find((f) => f.contactPhone)?.contactPhone ?? null;
  const email = data.facilities.find((f) => f.contactEmail)?.contactEmail ?? null;
  const hasReviews = data.testimonials.length > 0;
  const faqs: FaqItem[] = data.faqs.length > 0 ? data.faqs : (tFaq.raw('defaults') as FaqItem[]);

  // Copy editable por el tenant (Ajustes → Web). Vacío → textos por defecto.
  const content = data.webContent;
  const heroSubtitle =
    content?.heroSubtitle?.trim() || t('heroSubtitle', { tenantName: data.tenantName });
  const advCustom = (content?.advantages ?? []).filter((a) => a.trim());
  const advantages = (
    advCustom.length > 0
      ? advCustom
      : (t.raw('advantages') as { label: string }[]).map((a) => a.label)
  ).map((label, i) => ({ label, icon: ADVANTAGE_ICONS[i % ADVANTAGE_ICONS.length]! }));
  // «Para qué lo necesitas» usa el bloque de servicios editable (título + texto,
  // una línea por punto).
  const usesCustom = (content?.services ?? []).filter((s) => s.title.trim());
  const uses: UseItem[] = (
    usesCustom.length > 0
      ? usesCustom.map((s) => ({ title: s.title, text: s.text ?? '' }))
      : (t.raw('uses') as { title: string; text: string }[])
  ).map((u) => ({
    title: u.title,
    points: u.text
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean),
  }));
  const stepsCustom = (content?.steps ?? []).filter((s) => s.title.trim());
  const steps =
    stepsCustom.length > 0
      ? stepsCustom.map((s) => ({ title: s.title, text: s.text ?? '' }))
      : (t.raw('steps') as { title: string; text: string }[]);

  const units: UnitCard[] = data.facilities
    .flatMap((f) =>
      f.unitTypes.map((u) => ({
        key: `${f.id}:${u.id}`,
        facilityId: f.id,
        facilityName: f.name,
        city: f.city,
        unitTypeId: u.id,
        name: u.name,
        areaM2: u.areaM2,
        price: u.priceMonthly,
        available: u.available,
      })),
    )
    // Disponibles primero y, dentro, de menor a mayor tamaño (o precio).
    .sort(
      (a, b) =>
        Number(b.available > 0) - Number(a.available > 0) ||
        (a.areaM2 ?? a.price) - (b.areaM2 ?? b.price),
    );

  const navItems = [
    { id: 'centros', label: t('nav.centers') },
    { id: 'trasteros', label: t('nav.units') },
    { id: 'usos', label: t('nav.uses') },
    { id: 'como-funciona', label: t('nav.how') },
    ...(hasReviews || images.length > 0 ? [{ id: 'opiniones', label: t('nav.reviews') }] : []),
    { id: 'preguntas', label: t('nav.faq') },
    { id: 'contacto', label: t('nav.contact') },
  ];

  function goTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function facilityLink(f: PublicLandingDto['facilities'][number]): string {
    return f.publicSlug
      ? buildFacilityHref(data.tenantSlug, f.publicSlug, locale, data.customDomain)
      : buildBookHref(data.tenantSlug, locale, { facilityId: f.id });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background pb-20 md:pb-0">
      <GoogleAnalyticsScript measurementId={data.googleAnalyticsId} />
      <Header
        data={data}
        brand={brand}
        navItems={navItems}
        onNavigate={goTo}
        phone={phone}
        bookHref={bookHref}
        portalHref={portalHref}
        blogHref={blogHref}
        facilityLink={facilityLink}
      />

      {/* Portada */}
      <section className="relative isolate overflow-hidden px-4 py-20 text-white sm:py-28">
        {heroImage ? (
          <>
            <Image
              src={heroImage}
              alt=""
              aria-hidden
              fill
              priority
              sizes="100vw"
              className="-z-10 object-cover"
            />
            <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/75 via-black/50 to-black/20" />
          </>
        ) : (
          <div className="absolute inset-0 -z-10 bg-neutral-900" />
        )}
        <div className="mx-auto max-w-6xl">
          <h1 className="max-w-xl text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
            {data.webHeadline || headlineFallback}
          </h1>
          <p className="mt-4 max-w-lg text-lg opacity-95">{heroSubtitle}</p>
          <Link
            href={bookHref}
            onClick={() => trackEvent('cta_reservar_click', { location: 'hero_onepagemovil' })}
            className="mt-8 inline-flex h-12 items-center rounded-full px-8 text-base font-semibold text-white shadow-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: brand }}
          >
            {t('rentNow')}
          </Link>
        </div>
      </section>

      {/* Ventajas */}
      <section className="border-b bg-card">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-4 px-4 py-8 md:grid-cols-4">
          {advantages.map((a) => (
            <div key={a.label} className="flex items-center gap-3">
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: `${brand}1a`, color: brand }}
              >
                <a.icon className="h-5 w-5" />
              </div>
              <span className="text-sm font-medium leading-snug">{a.label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="flex-1">
        <div className="mx-auto max-w-6xl px-4 pt-6">
          <PromoBanner data={data} />
        </div>

        {/* Centros */}
        <section id="centros" className="scroll-mt-20 py-14">
          <div className="mx-auto max-w-6xl px-4">
            <SectionTitle title={t('centersTitle')} subtitle={t('centersSubtitle')} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.facilities.map((f) => (
                <Link
                  key={f.id}
                  href={facilityLink(f)}
                  className="flex items-center gap-3 rounded-xl border bg-card p-4 transition-shadow hover:shadow-md"
                >
                  <MapPin className="h-5 w-5 shrink-0" style={{ color: brand }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{f.city || f.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[f.name !== f.city ? f.name : null, f.address].filter(Boolean).join(' · ') ||
                        '—'}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Carrusel de trasteros */}
        <section id="trasteros" className="scroll-mt-20 bg-muted/40 py-14">
          <div className="mx-auto max-w-6xl px-4">
            <SectionTitle title={t('unitsTitle')} subtitle={t('unitsSubtitle')} />
            {units.length > 0 ? (
              <Carousel prevLabel={t('prev')} nextLabel={t('next')}>
                {units.map((u) => (
                  <UnitCardView
                    key={u.key}
                    unit={u}
                    brand={brand}
                    locale={locale}
                    tenantSlug={data.tenantSlug}
                  />
                ))}
              </Carousel>
            ) : (
              <p className="rounded-xl border bg-card px-4 py-10 text-center text-muted-foreground">
                {t('noUnits')}
              </p>
            )}
          </div>
        </section>

        {/* Para qué lo necesitas */}
        <section id="usos" className="scroll-mt-20 py-14">
          <div className="mx-auto max-w-6xl px-4">
            <SectionTitle title={t('usesTitle')} />
            <div className="grid gap-3 md:grid-cols-2">
              {uses.map((u, i) => (
                <details key={u.title} className="group rounded-xl border bg-card" open={i === 0}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-semibold marker:content-none">
                    {u.title}
                    <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="px-4 pb-4">
                    <ul className="space-y-1.5 text-sm text-muted-foreground">
                      {u.points.map((p) => (
                        <li key={p} className="flex gap-2">
                          <span
                            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: brand }}
                          />
                          {p}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => goTo('trasteros')}
                      className="mt-4 inline-flex h-10 items-center rounded-full px-5 text-sm font-semibold text-white"
                      style={{ backgroundColor: brand }}
                    >
                      {t('usesCta')}
                    </button>
                  </div>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Cómo funciona */}
        <section id="como-funciona" className="scroll-mt-20 bg-neutral-900 py-14 text-white">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight sm:text-3xl">
              {t('stepsTitle')}
            </h2>
            <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((s, i) => (
                <li key={s.title} className="flex gap-4 lg:flex-col lg:items-center lg:text-center">
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg font-bold"
                    style={{ backgroundColor: brand }}
                  >
                    {i + 1}
                  </span>
                  <div>
                    <p className="font-semibold">{s.title}</p>
                    <p className="mt-1 text-sm text-white/75">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-10 text-center">
              <Link
                href={bookHref}
                onClick={() => trackEvent('cta_reservar_click', { location: 'steps_onepagemovil' })}
                className="inline-flex h-12 items-center rounded-full bg-white px-8 text-sm font-semibold text-neutral-900 shadow-lg"
              >
                {t('rentNow')}
              </Link>
            </div>
          </div>
        </section>

        {/* Calculadora de espacio */}
        <section className="py-14">
          <div className="mx-auto max-w-6xl px-4">
            <StorageCalculator data={data} brand={brand} locale={locale} />
          </div>
        </section>

        {/* Opiniones + galería */}
        {(hasReviews || images.length > 0) && (
          <section id="opiniones" className="scroll-mt-20 bg-muted/40 py-14">
            <div className="mx-auto max-w-6xl space-y-10 px-4">
              {hasReviews && (
                <div>
                  <SectionTitle title={tTestimonials('title')} />
                  <Carousel prevLabel={t('prev')} nextLabel={t('next')}>
                    {data.testimonials.map((r, i) => (
                      <figure
                        key={i}
                        className="w-[85%] shrink-0 snap-start rounded-xl border bg-card p-5 shadow-sm sm:w-[45%] lg:w-[31%]"
                      >
                        <div className="flex gap-0.5">
                          {Array.from({ length: r.rating ?? 5 }).map((_, s) => (
                            <Star key={s} className="h-4 w-4 fill-amber-400 text-amber-400" />
                          ))}
                        </div>
                        <blockquote className="mt-2 text-sm leading-relaxed">
                          {r.comment}
                        </blockquote>
                        <figcaption className="mt-3 text-xs font-medium text-muted-foreground">
                          {r.author}
                        </figcaption>
                      </figure>
                    ))}
                  </Carousel>
                  {data.googleReviewUrl && (
                    <div className="mt-6 flex justify-center">
                      <GoogleReviewBadge url={data.googleReviewUrl} />
                    </div>
                  )}
                </div>
              )}
              {images.length > 0 && (
                <div>
                  <SectionTitle title={t('galleryTitle')} />
                  <Carousel prevLabel={t('prev')} nextLabel={t('next')}>
                    {images.map((src, i) => (
                      <div
                        key={src}
                        className="relative aspect-[4/3] w-[85%] shrink-0 snap-start overflow-hidden rounded-xl bg-muted sm:w-[45%] lg:w-[31%]"
                      >
                        <Image
                          src={src}
                          alt={`${data.tenantName} ${i + 1}`}
                          fill
                          loading="lazy"
                          sizes="(min-width: 1024px) 31vw, (min-width: 640px) 45vw, 85vw"
                          className="object-cover"
                        />
                      </div>
                    ))}
                  </Carousel>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Preguntas frecuentes */}
        <section id="preguntas" className="scroll-mt-20 py-14">
          <div className="mx-auto max-w-3xl px-4">
            <SectionTitle title={tFaq('title')} />
            <div className="divide-y rounded-xl border bg-card">
              {faqs.map((f, i) => (
                <details key={i} className="group px-5 py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium marker:content-none">
                    {f.question}
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                    {f.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Blog */}
        {blogHref && data.latestBlogPosts.length > 0 && (
          <section className="bg-muted/40 py-14">
            <div className="mx-auto max-w-6xl px-4">
              <SectionTitle title={t('blogTitle')} />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {data.latestBlogPosts.map((p) => (
                  <Link
                    key={p.slug}
                    href={buildBlogPostHref(data.tenantSlug, p.slug, locale, data.customDomain)}
                    className="group overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md"
                  >
                    <div className="relative aspect-[16/10] bg-muted">
                      {p.coverImageUrl ? (
                        <Image
                          src={p.coverImageUrl}
                          alt=""
                          fill
                          loading="lazy"
                          sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
                          className="object-cover transition-transform group-hover:scale-105"
                        />
                      ) : (
                        <div
                          className="h-full w-full"
                          style={{ background: `linear-gradient(135deg, ${brand}22, ${brand}55)` }}
                        />
                      )}
                    </div>
                    <div className="p-4">
                      <p className="text-xs text-muted-foreground">
                        {new Date(p.publishedAt).toLocaleDateString(intlLocaleFor(locale), {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        })}
                      </p>
                      <p className="mt-1 font-semibold leading-snug">{p.title}</p>
                    </div>
                  </Link>
                ))}
              </div>
              <div className="mt-6 text-center">
                <Link
                  href={blogHref}
                  className="text-sm font-semibold hover:underline"
                  style={{ color: brand }}
                >
                  {t('blogMore')}
                </Link>
              </div>
            </div>
          </section>
        )}

        {/* Contacto */}
        <section id="contacto" className="scroll-mt-20 py-14">
          <div className="mx-auto max-w-6xl px-4">
            <SectionTitle
              title={tCommon('contactSectionTitle')}
              subtitle={tCommon('contactSectionSubtitle')}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div className="rounded-xl border p-5" style={{ backgroundColor: `${brand}0d` }}>
                  <p className="font-semibold">{t('recoverTitle')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('recoverText')}</p>
                  <Link
                    href={portalHref}
                    className="mt-3 inline-flex h-10 items-center rounded-full px-5 text-sm font-semibold text-white"
                    style={{ backgroundColor: brand }}
                  >
                    {t('recoverCta')}
                  </Link>
                </div>
                {data.facilities.map((f) => (
                  <div key={f.id} className="rounded-xl border bg-card p-4 text-sm">
                    <p className="font-medium">{f.name}</p>
                    <p className="text-muted-foreground">
                      {[f.address, f.postalCode, f.city].filter(Boolean).join(', ') || '—'}
                    </p>
                    {f.contactPhone && (
                      <div className="mt-1 flex flex-wrap items-center gap-3">
                        <a
                          href={`tel:${f.contactPhone}`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {f.contactPhone}
                        </a>
                        <WhatsAppButton phone={f.contactPhone} tenantName={data.tenantName} />
                      </div>
                    )}
                    <div className="mt-1">
                      <OpeningHoursInfo hours={f.openingHours} timezone={f.timezone} />
                    </div>
                  </div>
                ))}
              </div>
              {data.contactEnabled && (
                <div>
                  <ContactForm slug={data.tenantSlug} brand={brand} />
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Pie */}
      <footer className="bg-neutral-900 text-white/80">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-3">
          <div className="space-y-2">
            {data.logoUrl ? (
              <Image
                src={data.logoUrl}
                alt={data.tenantName}
                width={140}
                height={32}
                className="h-8 w-auto object-contain brightness-0 invert"
              />
            ) : (
              <p className="text-base font-semibold text-white">{data.tenantName}</p>
            )}
            {phone && (
              <a href={`tel:${phone}`} className="block hover:text-white">
                {phone}
              </a>
            )}
            {email && (
              <a href={`mailto:${email}`} className="block hover:text-white">
                {email}
              </a>
            )}
          </div>
          <div>
            <p className="mb-2 font-semibold text-white">{t('footerCenters')}</p>
            <ul className="space-y-1">
              {data.facilities.map((f) => (
                <li key={f.id}>
                  <Link href={facilityLink(f)} className="hover:text-white">
                    {f.city || f.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 font-semibold text-white">{t('footerLinks')}</p>
            <ul className="space-y-1">
              <li>
                <button
                  type="button"
                  onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                  className="hover:text-white"
                >
                  {t('footerHome')}
                </button>
              </li>
              <li>
                <Link href={bookHref} className="hover:text-white">
                  {t('rentNow')}
                </Link>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => goTo('preguntas')}
                  className="hover:text-white"
                >
                  {tFaq('title')}
                </button>
              </li>
              {blogHref && (
                <li>
                  <Link href={blogHref} className="hover:text-white">
                    {tBlog('title')}
                  </Link>
                </li>
              )}
              <li>
                <Link href={portalHref} className="hover:text-white">
                  {tChrome('clientAccess')}
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-4 text-xs text-white/60 sm:flex-row sm:justify-between">
            <p>
              © {new Date().getUTCFullYear()} {data.tenantName}
            </p>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white"
            >
              {tCommon('createdWith', { name: 'TrasterOS' })}
            </a>
          </div>
        </div>
      </footer>

      {/* Barra fija en el móvil */}
      <div className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur md:hidden">
        <div className="flex gap-2 px-3 py-2">
          {phone && (
            <a
              href={`tel:${phone}`}
              className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full border text-sm font-semibold"
            >
              <Phone className="h-4 w-4" /> {t('call')}
            </a>
          )}
          <Link
            href={bookHref}
            onClick={() =>
              trackEvent('cta_reservar_click', { location: 'mobile_bar_onepagemovil' })
            }
            className="inline-flex h-12 flex-[2] items-center justify-center rounded-full text-sm font-semibold text-white"
            style={{ backgroundColor: brand }}
          >
            {t('rentNow')}
          </Link>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

/** Fila deslizable (con el dedo en el móvil; con flechas en escritorio). */
function Carousel({
  children,
  prevLabel,
  nextLabel,
}: {
  children: React.ReactNode;
  prevLabel: string;
  nextLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function scroll(dir: 1 | -1) {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' });
  }
  return (
    <div className="relative">
      <div
        ref={ref}
        className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      <div className="mt-3 hidden justify-end gap-2 md:flex">
        <button
          type="button"
          onClick={() => scroll(-1)}
          aria-label={prevLabel}
          className="flex h-10 w-10 items-center justify-center rounded-full border bg-card hover:bg-accent"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => scroll(1)}
          aria-label={nextLabel}
          className="flex h-10 w-10 items-center justify-center rounded-full border bg-card hover:bg-accent"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function UnitCardView({
  unit,
  brand,
  locale,
  tenantSlug,
}: {
  unit: UnitCard;
  brand: string;
  locale: PublicWebLocale;
  tenantSlug: string;
}) {
  const t = useTranslations('publicWeb.onepagemovil');
  const tCommon = useTranslations('publicWeb.common');
  const soldOut = unit.available <= 0;
  const href = buildBookHref(tenantSlug, locale, {
    facilityId: unit.facilityId,
    unitTypeId: unit.unitTypeId,
    ...(soldOut ? { waitlist: true } : {}),
  });
  return (
    <div
      className={`flex w-[78%] shrink-0 snap-start flex-col rounded-xl border bg-card p-5 shadow-sm sm:w-[45%] lg:w-[23%] ${soldOut ? 'opacity-70' : ''}`}
    >
      <p className="text-3xl font-extrabold tracking-tight" style={{ color: brand }}>
        {unit.areaM2 != null ? t('sizeM2', { m2: unit.areaM2 }) : unit.name}
      </p>
      {unit.areaM2 != null && <p className="text-sm font-medium">{unit.name}</p>}
      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin className="h-3.5 w-3.5" /> {unit.city || unit.facilityName}
      </p>
      <p className="mt-4 text-sm text-muted-foreground">
        {tCommon('from')}{' '}
        <span className="text-xl font-bold text-foreground">
          {formatPrice(unit.price * 1.21, locale)}
        </span>
        {t('perMonth')}
      </p>
      <p className="mt-1 h-4 text-xs font-medium">
        {soldOut ? (
          <span className="text-muted-foreground">{tCommon('soldOut')}</span>
        ) : unit.available <= 2 ? (
          <span className="text-amber-600">
            {unit.available === 1
              ? tCommon('urgentOne')
              : tCommon('urgentFew', { count: unit.available })}
          </span>
        ) : null}
      </p>
      <Link
        href={href}
        onClick={() =>
          !soldOut && trackEvent('cta_reservar_click', { location: 'unit_card_onepagemovil' })
        }
        className="mt-4 inline-flex h-11 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={{ backgroundColor: soldOut ? '#525252' : brand }}
      >
        {soldOut ? tCommon('notifyMe') : t('reserve')}
      </Link>
    </div>
  );
}

/** Cabecera fija: logo, centros, secciones, teléfono, «Alquilar ya» y área de clientes. */
function Header({
  data,
  brand,
  navItems,
  onNavigate,
  phone,
  bookHref,
  portalHref,
  blogHref,
  facilityLink,
}: {
  data: PublicLandingDto;
  brand: string;
  navItems: { id: string; label: string }[];
  onNavigate: (id: string) => void;
  phone: string | null;
  bookHref: string;
  portalHref: string;
  blogHref: string | undefined;
  facilityLink: (f: PublicLandingDto['facilities'][number]) => string;
}) {
  const t = useTranslations('publicWeb.onepagemovil');
  const tChrome = useTranslations('publicWeb.chrome');
  const tBlog = useTranslations('publicWeb.blog');
  const [open, setOpen] = useState(false);

  function go(id: string) {
    setOpen(false);
    onNavigate(id);
  }

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="flex items-center font-semibold"
          aria-label={data.tenantName}
        >
          {data.logoUrl ? (
            <Image
              src={data.logoUrl}
              alt={data.tenantName}
              width={130}
              height={30}
              className="h-8 w-auto object-contain"
            />
          ) : (
            <span className="text-lg">{data.tenantName}</span>
          )}
        </button>

        <nav className="hidden items-center gap-1 lg:flex">
          {data.facilities.length > 1 && (
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground marker:content-none">
                {t('centersMenu')} <ChevronDown className="h-4 w-4" />
              </summary>
              <div className="absolute left-0 top-full mt-1 w-56 rounded-lg border bg-popover p-1 shadow-lg">
                {data.facilities.map((f) => (
                  <Link
                    key={f.id}
                    href={facilityLink(f)}
                    className="block rounded-md px-3 py-2 text-sm hover:bg-accent"
                  >
                    {f.city || f.name}
                  </Link>
                ))}
              </div>
            </details>
          )}
          {navItems
            .filter((it) => it.id !== 'centros' || data.facilities.length <= 1)
            .map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => go(it.id)}
                className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                {it.label}
              </button>
            ))}
          {blogHref && (
            <Link
              href={blogHref}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {tBlog('title')}
            </Link>
          )}
        </nav>

        <div className="flex items-center gap-2">
          {phone && (
            <a
              href={`tel:${phone}`}
              aria-label={t('call')}
              className="hidden h-10 w-10 items-center justify-center rounded-full border sm:flex"
            >
              <Phone className="h-4 w-4" />
            </a>
          )}
          <Link
            href={portalHref}
            className="hidden h-10 items-center rounded-full border px-4 text-sm font-medium md:inline-flex"
          >
            {tChrome('clientAccess')}
          </Link>
          <Link
            href={bookHref}
            onClick={() => trackEvent('cta_reservar_click', { location: 'header_onepagemovil' })}
            className="hidden h-10 items-center rounded-full px-5 text-sm font-semibold text-white sm:inline-flex"
            style={{ backgroundColor: brand }}
          >
            {t('rentNow')}
          </Link>
          <button
            type="button"
            aria-label={t('openMenu')}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex h-10 w-10 items-center justify-center rounded-full border lg:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {open && (
        <nav className="border-t lg:hidden">
          <div className="mx-auto flex max-w-6xl flex-col px-2 py-2">
            {navItems.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => go(it.id)}
                className="rounded-md px-3 py-3 text-left text-base font-medium hover:bg-accent"
              >
                {it.label}
              </button>
            ))}
            {blogHref && (
              <Link
                href={blogHref}
                className="rounded-md px-3 py-3 text-base font-medium hover:bg-accent"
              >
                {tBlog('title')}
              </Link>
            )}
            <Link
              href={portalHref}
              className="rounded-md px-3 py-3 text-base font-medium hover:bg-accent"
            >
              {tChrome('clientAccess')}
            </Link>
          </div>
        </nav>
      )}
    </header>
  );
}
