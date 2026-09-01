'use client';

import {
  Briefcase,
  Building2,
  CalendarX,
  Clock,
  Gauge,
  Home,
  Lock,
  ShieldCheck,
  ShoppingBag,
  Star,
  Users,
  Wallet,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ContactForm } from './contact-form';
import { GoogleAnalyticsScript, trackEvent } from './google-analytics';
import {
  blogHref as buildBlogHref,
  bookHref as buildBookHref,
  type PublicWebLocale,
} from './i18n/messages';
import { OnePageNav, type OnePageNavItem } from './onepage-nav';
import { StorageCalculator } from './storage-calculator';
import {
  cities,
  FacilityMap,
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

type ServiceItem = { icon: LucideIcon; title: string; text: string };
type AdvantageItem = { icon: LucideIcon; label: string };
type FaqItem = { question: string; answer: string };

/** Iconos fijos por posición (el tenant edita el texto, no el icono). */
const SERVICE_ICONS: LucideIcon[] = [ShieldCheck, Wallet, Users];
const ADVANTAGE_ICONS: LucideIcon[] = [Clock, Lock, Gauge, CalendarX];
/**
 * «Soluciones por tipo de cliente» — a diferencia de servicios/ventajas, NO es
 * editable por el tenant (no encaja en `webContent`, que es label-only o
 * título+texto de un único set): son 4 bloques fijos de contenido genérico,
 * igual que la `TrustBar` auto-generada.
 */
const SOLUTION_ICONS: LucideIcon[] = [Home, Building2, Briefcase, ShoppingBag];

/**
 * Plantilla premium «Corporativa»: web multisección al estilo de las grandes
 * cadenas de self-storage (quiénes somos, servicios, soluciones por tipo de
 * cliente, centros, calculadora, ventajas, opiniones, FAQ y contacto).
 * Autocontenida (menú + pie propios, como Onepage/Escaparate); la página no
 * la envuelve en `TenantWebChrome`.
 */
export function CorporateTemplate({
  data,
  locale,
}: {
  data: PublicLandingDto;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.corporate');
  const tCommon = useTranslations('publicWeb.common');
  const tChrome = useTranslations('publicWeb.chrome');
  const tTestimonials = useTranslations('publicWeb.testimonials');
  const tFaq = useTranslations('publicWeb.faq');
  const brand = data.brandColor ?? '#2563EB';
  const where = cities(data);
  const trasterosLabel = useHeadlineFallback(where);
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const bookHref = buildBookHref(data.tenantSlug, locale);
  const blogHref = data.hasBlog ? buildBlogHref(data.tenantSlug, locale) : undefined;
  const heroImage = data.facilities.flatMap((f) => f.imageUrls)[0] ?? null;
  const hasReviews = data.testimonials.length > 0;
  const defaultFaqs = tFaq.raw('defaults') as FaqItem[];
  const faqs = data.faqs.length > 0 ? data.faqs : defaultFaqs;
  const solutions = t.raw('solutions') as { title: string; text: string }[];

  // Copy editable por el tenant (Ajustes → Web). Vacío → textos por defecto.
  const content = data.webContent;
  const heroSubtitle =
    content?.heroSubtitle?.trim() || t('heroSubtitle', { tenantName: data.tenantName });
  const defaultServices = t.raw('services') as { title: string; text: string }[];
  const svcCustom = (content?.services ?? [])
    .filter((s) => s.title.trim())
    .map((s, i) => ({
      icon: SERVICE_ICONS[i % SERVICE_ICONS.length]!,
      title: s.title,
      text: s.text ?? '',
    }));
  const services: ServiceItem[] =
    svcCustom.length > 0
      ? svcCustom
      : defaultServices.map((s, i) => ({ icon: SERVICE_ICONS[i % SERVICE_ICONS.length]!, ...s }));
  const defaultAdvantages = t.raw('advantages') as { label: string }[];
  const advCustom = (content?.advantages ?? [])
    .filter((a) => a.trim())
    .map((label, i) => ({ icon: ADVANTAGE_ICONS[i % ADVANTAGE_ICONS.length]!, label }));
  const advantages: AdvantageItem[] =
    advCustom.length > 0
      ? advCustom
      : defaultAdvantages.map((a, i) => ({
          icon: ADVANTAGE_ICONS[i % ADVANTAGE_ICONS.length]!,
          ...a,
        }));

  const navItems: OnePageNavItem[] = [
    { id: 'quienes-somos', label: t('nav.about') },
    { id: 'servicios', label: t('nav.services') },
    { id: 'soluciones', label: t('nav.solutions') },
    { id: 'centros', label: t('nav.centers') },
    { id: 'ventajas', label: t('nav.advantages') },
    ...(hasReviews ? [{ id: 'opiniones', label: t('nav.reviews') }] : []),
    { id: 'contacto', label: tCommon('contactSectionTitle') },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <GoogleAnalyticsScript measurementId={data.googleAnalyticsId} />
      <OnePageNav
        items={navItems}
        brand={brand}
        tenantName={data.tenantName}
        logoUrl={data.logoUrl}
        portalHref={portalHref}
        blogHref={blogHref}
      />

      {/* Hero */}
      <section className="relative isolate overflow-hidden px-4 py-24 text-center text-white sm:py-28">
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
            <div className="absolute inset-0 -z-10 bg-black/55" />
          </>
        ) : (
          <div
            className="absolute inset-0 -z-10"
            style={{ background: `linear-gradient(135deg, ${brand}, ${brand}cc)` }}
          />
        )}
        <h1 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
          {data.webHeadline || trasterosLabel}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg opacity-95">{heroSubtitle}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={bookHref}
            onClick={() => trackEvent('cta_reservar_click', { location: 'hero_corporate' })}
            className="inline-flex h-12 items-center rounded-md px-8 text-sm font-semibold text-white shadow-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: brand }}
          >
            {tCommon('reserveNow')}
          </Link>
          <Link
            href={portalHref}
            className="inline-flex h-12 items-center rounded-md bg-white px-8 text-sm font-semibold text-neutral-900 shadow-lg transition-transform hover:scale-105"
          >
            {tChrome('clientAccess')}
          </Link>
        </div>
      </section>

      <div className="flex-1">
        <div className="mx-auto max-w-6xl px-4 pt-8">
          <PromoBanner data={data} />
        </div>

        {/* Quiénes somos */}
        <section id="quienes-somos" className="scroll-mt-20 py-16">
          <div className="mx-auto max-w-3xl px-4 text-center">
            <h2 className="mb-6 text-2xl font-bold tracking-tight">{t('quienesSomosTitle')}</h2>
            <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
              {data.webAbout || t('quienesSomosDefault')}
            </p>
          </div>
        </section>

        {/* Servicios principales */}
        <section id="servicios" className="scroll-mt-20 bg-muted/40 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">
              {t('servicesTitle')}
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {services.map((s) => (
                <div key={s.title} className="rounded-lg border bg-card p-6 text-center shadow-sm">
                  <div
                    className="mx-auto flex h-12 w-12 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${brand}1a`, color: brand }}
                  >
                    <s.icon className="h-6 w-6" />
                  </div>
                  <h3 className="mt-3 font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Soluciones por tipo de cliente */}
        <section id="soluciones" className="scroll-mt-20 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">
              {t('solutionsTitle')}
            </h2>
            <p className="mb-8 text-center text-sm text-muted-foreground">
              {t('solutionsSubtitle')}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {solutions.map((s, i) => {
                const Icon = SOLUTION_ICONS[i % SOLUTION_ICONS.length]!;
                return (
                  <div key={s.title} className="rounded-lg border bg-card p-6 shadow-sm">
                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-full"
                      style={{ backgroundColor: `${brand}1a`, color: brand }}
                    >
                      <Icon className="h-6 w-6" />
                    </div>
                    <h3 className="mt-4 font-semibold">{s.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Centros / localizaciones */}
        <section id="centros" className="scroll-mt-20 bg-muted/40 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">
              {where ? t('centersTitleWithCity', { city: where }) : t('centersTitleDefault')}
            </h2>
            {data.facilities.length > 0 ? (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {data.facilities.map((f) => {
                  const img = f.imageUrls[0] ?? null;
                  const cheapest = f.unitTypes
                    .filter((unitType) => unitType.available > 0)
                    .reduce<
                      number | null
                    >((min, unitType) => (min === null ? unitType.priceMonthly : Math.min(min, unitType.priceMonthly)), null);
                  const href = f.publicSlug
                    ? `/s/${data.tenantSlug}/${f.publicSlug}`
                    : buildBookHref(data.tenantSlug, locale, { facilityId: f.id });
                  return (
                    <Link
                      key={f.id}
                      href={href}
                      className="group overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md"
                    >
                      <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
                        {img ? (
                          <Image
                            src={img}
                            alt={f.name}
                            fill
                            loading="lazy"
                            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                            className="object-cover transition-transform group-hover:scale-105"
                          />
                        ) : (
                          <div
                            className="h-full w-full"
                            style={{
                              background: `linear-gradient(135deg, ${brand}22, ${brand}66)`,
                            }}
                          />
                        )}
                      </div>
                      <div className="p-4">
                        <h3 className="font-semibold">{f.name}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {[f.address, f.city].filter(Boolean).join(', ') || '—'}
                        </p>
                        {cheapest !== null && (
                          <p className="mt-2 text-sm font-semibold" style={{ color: brand }}>
                            {tCommon('from')} {formatPrice(cheapest * 1.21, locale)}
                            {t('perMonth')}
                          </p>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-md border bg-card px-4 py-10 text-center text-muted-foreground">
                {t('noAvailability')}
              </p>
            )}
          </div>
        </section>

        {/* Calculadora de espacio (gratis en toda web /s/[slug]) */}
        <section className="py-16">
          <div className="mx-auto max-w-6xl px-4">
            <StorageCalculator data={data} brand={brand} locale={locale} />
          </div>
        </section>

        {/* Por qué elegirnos */}
        <section id="ventajas" className="scroll-mt-20 bg-muted/40 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">
              {t('advantagesTitle')}
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {advantages.map((a) => (
                <div key={a.label} className="flex flex-col items-center gap-2 text-center">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${brand}1a`, color: brand }}
                  >
                    <a.icon className="h-6 w-6" />
                  </div>
                  <span className="text-sm font-medium">{a.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Opiniones (si hay reseñas) */}
        {hasReviews && (
          <section id="opiniones" className="scroll-mt-20 py-16">
            <div className="mx-auto max-w-6xl px-4">
              <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">
                {tTestimonials('title')}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.testimonials.map((testimonial, i) => (
                  <figure key={i} className="rounded-lg border bg-card p-5 shadow-sm">
                    <div className="flex items-center gap-0.5">
                      {Array.from({ length: testimonial.rating ?? 5 }).map((_, s) => (
                        <Star
                          key={s}
                          className="h-4 w-4 fill-current"
                          style={{ color: '#f59e0b' }}
                        />
                      ))}
                    </div>
                    <blockquote className="mt-2 text-sm leading-relaxed">
                      {testimonial.comment}
                    </blockquote>
                    <figcaption className="mt-3 text-xs font-medium text-muted-foreground">
                      {testimonial.author}
                    </figcaption>
                  </figure>
                ))}
              </div>
              {data.googleReviewUrl && (
                <div className="mt-8 flex justify-center">
                  <GoogleReviewBadge url={data.googleReviewUrl} />
                </div>
              )}
            </div>
          </section>
        )}

        {/* Banda CTA */}
        <section className="px-4 py-14 text-center text-white" style={{ backgroundColor: brand }}>
          <h2 className="text-2xl font-bold tracking-tight">{t('ctaTitle')}</h2>
          <p className="mx-auto mt-2 max-w-xl opacity-95">{t('ctaSubtitle')}</p>
          <Link
            href={bookHref}
            onClick={() => trackEvent('cta_reservar_click', { location: 'cta_band_corporate' })}
            className="mt-6 inline-flex h-12 items-center rounded-md bg-white px-8 text-sm font-semibold text-neutral-900 shadow-lg transition-transform hover:scale-105"
          >
            {tCommon('reserveNow')}
          </Link>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-20 py-16">
          <div className="mx-auto max-w-2xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">{tFaq('title')}</h2>
            <div className="divide-y rounded-lg border bg-card">
              {faqs.map((f, i) => (
                <details key={i} className="group px-5 py-4">
                  <summary className="cursor-pointer list-none font-medium marker:content-none">
                    {f.question}
                  </summary>
                  <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                    {f.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Contacto */}
        <section id="contacto" className="scroll-mt-20 bg-muted/40 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">
              {tCommon('contactSectionTitle')}
            </h2>
            <p className="mb-8 text-center text-sm text-muted-foreground">
              {tCommon('contactSectionSubtitle')}
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                {data.facilities.map((f) => (
                  <div key={f.id} className="rounded-lg border bg-card p-4 text-sm">
                    <p className="font-medium">{f.name}</p>
                    <p className="text-muted-foreground">
                      {[f.address, f.postalCode, f.city].filter(Boolean).join(', ') || '—'}
                    </p>
                    {f.contactPhone && (
                      <a
                        href={`tel:${f.contactPhone}`}
                        className="block text-muted-foreground hover:text-foreground"
                      >
                        {f.contactPhone}
                      </a>
                    )}
                    {f.contactEmail && (
                      <a
                        href={`mailto:${f.contactEmail}`}
                        className="block text-muted-foreground hover:text-foreground"
                      >
                        {f.contactEmail}
                      </a>
                    )}
                    {f.contactPhone && (
                      <div className="mt-1">
                        <WhatsAppButton phone={f.contactPhone} tenantName={data.tenantName} />
                      </div>
                    )}
                    <div className="mt-1">
                      <OpeningHoursInfo hours={f.openingHours} timezone={f.timezone} />
                    </div>
                    <div className="mt-2">
                      <FacilityMap f={f} />
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
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getUTCFullYear()} {data.tenantName}
          </p>
          <div className="flex items-center gap-4">
            <Link href={portalHref} className="transition hover:text-foreground">
              {tChrome('clientAccess')}
            </Link>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-foreground"
            >
              {tCommon('createdWith', { name: 'TrasterOS' })}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
