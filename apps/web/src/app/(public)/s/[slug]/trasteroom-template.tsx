'use client';

import { mapEmbedUrl, WEEKDAYS } from '@storageos/shared';
import {
  ArrowRight,
  Bell,
  Box,
  ChevronDown,
  Lock,
  Mail,
  MapPin,
  Menu,
  Phone,
  Star,
  User,
  Warehouse,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ContactForm } from './contact-form';
import { GoogleAnalyticsScript, trackEvent } from './google-analytics';
import {
  blogHref as buildBlogHref,
  blogPostHref as buildBlogPostHref,
  bookHref as buildBookHref,
  intlLocaleFor,
  type PublicWebLocale,
} from './i18n/messages';
import { StorageCalculator } from './storage-calculator';
import { cities, formatPrice, isOpenNow, useHeadlineFallback } from './templates';

import type { PublicLandingDto } from '@storageos/shared';

const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';

/** Icono fijo por posición de las tarjetas de «¿Por qué alquilar con nosotros?». */
const SITUATION_EMOJIS = ['📦', '🏡', '💼', '🔒', '🚚', '🗓️'];

type Facility = PublicLandingDto['facilities'][number];
type UnitType = Facility['unitTypes'][number];
type Item = { title: string; text: string };

/** Tamaño orientativo del trastero por sus m² (para la etiqueta y el «ideal para»). */
function sizeOf(areaM2: number | null): 'small' | 'medium' | 'large' | null {
  if (areaM2 == null) return null;
  if (areaM2 < 3) return 'small';
  if (areaM2 <= 7) return 'medium';
  return 'large';
}

function whatsAppHref(phone: string, message: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

/**
 * Plantilla premium «Trasteroom»: web de una página con barra de promoción,
 * portada a dos columnas, ventajas, ficha de cada centro con mapa y horario,
 * trasteros por centro (pestañas) con disponibilidad, pasos, calculadora,
 * opiniones, preguntas, blog, contacto y barra fija en el móvil. Autocontenida
 * (cabecera y pie propios), como OnePageMovil.
 */
export function TrasteroomTemplate({
  data,
  locale,
}: {
  data: PublicLandingDto;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.trasteroom');
  const tCommon = useTranslations('publicWeb.common');
  const tFaq = useTranslations('publicWeb.faq');
  const tPromo = useTranslations('publicWeb.promo');

  const brand = data.brandColor ?? '#2563EB';
  const where = cities(data);
  const headlineFallback = useHeadlineFallback(where);
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const bookHref = buildBookHref(data.tenantSlug, locale);
  const blogHref = data.hasBlog
    ? buildBlogHref(data.tenantSlug, locale, data.customDomain)
    : undefined;
  const heroImage = data.facilities.flatMap((f) => f.imageUrls)[0] ?? null;
  const phone = data.facilities.find((f) => f.contactPhone)?.contactPhone ?? null;
  const email = data.facilities.find((f) => f.contactEmail)?.contactEmail ?? null;
  const whatsapp = phone
    ? whatsAppHref(phone, tCommon('whatsappPrefill', { tenantName: data.tenantName }))
    : null;
  const faqs: { question: string; answer: string }[] =
    data.faqs.length > 0
      ? data.faqs
      : (tFaq.raw('defaults') as { question: string; answer: string }[]);

  // Textos editables (Ajustes → Web). Vacío → textos por defecto.
  const content = data.webContent;
  const heroSubtitle =
    content?.heroSubtitle?.trim() || t('heroSubtitle', { tenantName: data.tenantName });
  const advCustom = (content?.advantages ?? []).filter((a) => a.trim());
  const advantages = advCustom.length > 0 ? advCustom : (t.raw('advantages') as string[]);
  const situationsCustom = (content?.services ?? []).filter((s) => s.title.trim());
  const situations: Item[] =
    situationsCustom.length > 0
      ? situationsCustom.map((s) => ({ title: s.title, text: s.text ?? '' }))
      : (t.raw('situations') as Item[]);
  const stepsCustom = (content?.steps ?? []).filter((s) => s.title.trim());
  const steps: Item[] =
    stepsCustom.length > 0
      ? stepsCustom.map((s) => ({ title: s.title, text: s.text ?? '' }))
      : (t.raw('steps') as Item[]);

  const promo = data.activePromotion;
  const promoText = promo
    ? promo.discountType === 'percentage'
      ? tPromo('percentageOff', { value: promo.discountValue })
      : promo.discountType === 'fixed'
        ? tPromo('fixedOff', { value: `${promo.discountValue} €` })
        : tPromo('freeMonths', { count: promo.discountValue })
    : null;

  const navItems = [
    { id: 'locales', label: t('nav.centers') },
    { id: 'trasteros', label: t('nav.units') },
    { id: 'como-funciona', label: t('nav.how') },
    { id: 'calculadora', label: t('nav.calculator') },
    { id: 'faq', label: t('nav.faq') },
    ...(data.contactEnabled ? [{ id: 'contacto', label: t('nav.contact') }] : []),
  ];

  const [selectedFacility, setSelectedFacility] = useState(data.facilities[0]?.id ?? '');
  const facilityForUnits =
    data.facilities.find((f) => f.id === selectedFacility) ?? data.facilities[0];

  function goTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showUnitsOf(facilityId: string) {
    setSelectedFacility(facilityId);
    goTo('trasteros');
  }

  return (
    <div className="flex min-h-screen flex-col bg-muted/30 pb-20 text-foreground md:pb-0">
      <GoogleAnalyticsScript measurementId={data.googleAnalyticsId} />

      {/* Promoción activa */}
      {promo && promoText && (
        <aside
          className="relative z-50 px-4 py-2.5 text-center text-xs font-medium text-white sm:text-sm"
          style={{ backgroundColor: brand }}
        >
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-2">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs">
              ★
            </span>
            <span>{promoText}</span>
            <span className="rounded bg-white/25 px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-wider">
              {t('promoCode', { code: promo.code })}
            </span>
            <button
              type="button"
              onClick={() => goTo('trasteros')}
              className="ml-1 font-semibold underline underline-offset-2 hover:opacity-90"
            >
              {t('promoCta')} →
            </button>
          </div>
        </aside>
      )}

      <Header
        data={data}
        brand={brand}
        navItems={navItems}
        onNavigate={goTo}
        bookHref={bookHref}
        portalHref={portalHref}
        blogHref={blogHref}
      />

      {/* Portada */}
      <section className="relative overflow-hidden border-b bg-gradient-to-b from-muted/80 to-background pb-16 pt-10 lg:pb-24 lg:pt-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-12">
            <div className="space-y-6 text-center lg:col-span-7 lg:text-left">
              <div
                className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold tracking-wide sm:text-sm"
                style={{ backgroundColor: `${brand}1f`, color: brand }}
              >
                <span
                  className="h-2 w-2 animate-pulse rounded-full"
                  style={{ backgroundColor: brand }}
                />
                {t('badge')}
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-5xl sm:leading-none lg:text-6xl">
                {data.webHeadline || headlineFallback}
              </h1>
              <p className="mx-auto max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-xl lg:mx-0">
                {heroSubtitle}
              </p>
              <ul className="mx-auto grid max-w-xl grid-cols-1 gap-3 pt-2 text-left text-sm font-semibold sm:grid-cols-2 lg:mx-0">
                {advantages.slice(0, 4).map((a) => (
                  <li key={a} className="flex items-center gap-2.5">
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      style={{ backgroundColor: `${brand}1f`, color: brand }}
                    >
                      ✓
                    </span>
                    {a}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col items-center justify-center gap-3.5 pt-4 sm:flex-row lg:justify-start">
                <Link
                  href={bookHref}
                  onClick={() => trackEvent('cta_reservar_click', { location: 'hero_trasteroom' })}
                  className="inline-flex w-full items-center justify-center rounded-2xl px-8 py-4 text-base font-extrabold text-white shadow-lg transition hover:brightness-95 active:scale-95 sm:w-auto"
                  style={{ backgroundColor: brand }}
                >
                  {t('reserveOnline')}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
                {whatsapp && (
                  <a
                    href={whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackEvent('whatsapp_click')}
                    className="inline-flex w-full items-center justify-center rounded-2xl border bg-card px-6 py-4 text-base font-bold transition hover:bg-muted sm:w-auto"
                  >
                    <WhatsAppIcon className="mr-2 h-5 w-5" style={{ color: brand }} />
                    {t('whatsapp')}
                  </a>
                )}
              </div>
              {data.googleReviewUrl && (
                <div className="flex items-center justify-center gap-3 pt-2 lg:justify-start">
                  <div className="flex text-lg text-amber-400">★★★★★</div>
                  <a
                    href={data.googleReviewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground sm:text-sm"
                  >
                    {t('googleReviews')}
                  </a>
                </div>
              )}
            </div>

            <div className="relative lg:col-span-5">
              <div className="relative mx-auto aspect-[4/3] overflow-hidden rounded-3xl border-4 border-background bg-muted shadow-2xl lg:aspect-square">
                {heroImage ? (
                  <Image
                    src={heroImage}
                    alt={data.tenantName}
                    fill
                    priority
                    sizes="(min-width: 1024px) 40vw, 100vw"
                    className="object-cover"
                  />
                ) : (
                  <div
                    className="flex h-full w-full items-center justify-center"
                    style={{ background: `linear-gradient(135deg, ${brand}22, ${brand}66)` }}
                  >
                    <Warehouse className="h-24 w-24 text-white/80" />
                  </div>
                )}
                <div className="absolute inset-x-4 bottom-4 flex items-center justify-between rounded-2xl border bg-background/95 p-4 shadow-lg backdrop-blur">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('heroCardKicker')}
                    </p>
                    <p className="text-sm font-bold">{t('heroCardText')}</p>
                  </div>
                  <span
                    className="rounded-xl p-2.5"
                    style={{ backgroundColor: `${brand}1f`, color: brand }}
                  >
                    <Lock className="h-5 w-5" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Sobre nosotros */}
      {data.webAbout && (
        <section className="border-b bg-background py-14">
          <div className="mx-auto max-w-4xl space-y-4 px-4 text-center sm:px-6 lg:px-8">
            <Kicker brand={brand}>{t('aboutKicker')}</Kicker>
            <h2 className="text-2xl font-extrabold sm:text-3xl">
              {t('aboutTitle', { tenantName: data.tenantName })}
            </h2>
            <p className="whitespace-pre-line text-base leading-relaxed text-muted-foreground sm:text-lg">
              {data.webAbout}
            </p>
          </div>
        </section>
      )}

      {/* Ventajas / situaciones */}
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('situationsKicker')}
            title={t('situationsTitle')}
            subtitle={t('situationsSubtitle')}
          />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {situations.map((s, i) => (
              <div key={s.title} className="rounded-2xl border bg-card p-6 shadow-sm">
                <div
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-xl"
                  style={{ backgroundColor: `${brand}1f` }}
                  aria-hidden
                >
                  {SITUATION_EMOJIS[i % SITUATION_EMOJIS.length]}
                </div>
                <h3 className="mb-2 text-lg font-bold">{s.title}</h3>
                <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {s.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Centros */}
      <section id="locales" className="scroll-mt-24 border-b bg-background py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('centersKicker')}
            title={t('centersTitle')}
            subtitle={t('centersSubtitle')}
          />
          <div className="space-y-12">
            {data.facilities.map((f, i) => (
              <FacilityCard
                key={f.id}
                f={f}
                index={i}
                total={data.facilities.length}
                brand={brand}
                onShowUnits={() => showUnitsOf(f.id)}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Trasteros y precios por centro */}
      <section id="trasteros" className="scroll-mt-24 border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('unitsKicker')}
            title={t('unitsTitle')}
            subtitle={t('unitsSubtitle')}
          />
          {data.facilities.length > 1 && (
            <div className="mb-10 flex items-center gap-2 overflow-x-auto pb-2 sm:justify-center">
              {data.facilities.map((f) => {
                const active = f.id === facilityForUnits?.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSelectedFacility(f.id)}
                    aria-pressed={active}
                    className={`shrink-0 rounded-full border px-5 py-2.5 text-sm font-bold transition ${active ? 'text-white shadow-sm' : 'bg-card hover:bg-muted'}`}
                    style={active ? { backgroundColor: brand, borderColor: brand } : undefined}
                  >
                    {f.city && f.city !== f.name ? `${f.name} · ${f.city}` : f.name}
                  </button>
                );
              })}
            </div>
          )}
          {facilityForUnits && facilityForUnits.unitTypes.length > 0 ? (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[...facilityForUnits.unitTypes]
                .sort((a, b) => (a.areaM2 ?? a.priceMonthly) - (b.areaM2 ?? b.priceMonthly))
                .map((u) => (
                  <UnitTypeCard
                    key={u.id}
                    unit={u}
                    facilityId={facilityForUnits.id}
                    brand={brand}
                    locale={locale}
                    tenantSlug={data.tenantSlug}
                  />
                ))}
            </div>
          ) : (
            <p className="rounded-2xl border bg-card px-4 py-10 text-center text-muted-foreground">
              {t('noUnits')}
            </p>
          )}
        </div>
      </section>

      {/* Cómo funciona */}
      <section id="como-funciona" className="scroll-mt-24 border-b bg-background py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('stepsKicker')}
            title={t('stepsTitle')}
            subtitle={t('stepsSubtitle')}
          />
          <ol className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((s, i) => (
              <li key={s.title} className="rounded-2xl border bg-muted/40 p-6">
                <span className="text-4xl font-black opacity-50" style={{ color: brand }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="mb-1 mt-2 text-lg font-bold">{s.title}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Calculadora */}
      <section id="calculadora" className="scroll-mt-24 border-b py-16">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="mb-6 text-center">
            <Kicker brand={brand}>{t('calculatorKicker')}</Kicker>
          </div>
          <StorageCalculator data={data} brand={brand} locale={locale} />
        </div>
      </section>

      {/* Opiniones */}
      {data.testimonials.length > 0 && (
        <section className="border-b bg-background py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-10 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <Kicker brand={brand}>{t('reviewsKicker')}</Kicker>
                <h2 className="mt-1 text-2xl font-extrabold sm:text-3xl">{t('reviewsTitle')}</h2>
              </div>
              {data.googleReviewUrl && (
                <a
                  href={data.googleReviewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-bold hover:underline"
                  style={{ color: brand }}
                >
                  {t('allReviews')} →
                </a>
              )}
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {data.testimonials.slice(0, 6).map((r, i) => (
                <figure
                  key={i}
                  className="flex flex-col justify-between rounded-2xl border bg-muted/40 p-6"
                >
                  <div className="space-y-3">
                    <div className="flex gap-0.5">
                      {Array.from({ length: r.rating ?? 5 }).map((_, s) => (
                        <Star key={s} className="h-4 w-4 fill-amber-400 text-amber-400" />
                      ))}
                    </div>
                    <blockquote className="text-sm italic leading-relaxed">
                      “{r.comment}”
                    </blockquote>
                  </div>
                  <figcaption className="mt-4 flex items-center gap-3 border-t pt-4">
                    <span
                      className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-black"
                      style={{ backgroundColor: `${brand}1f`, color: brand }}
                    >
                      {r.author.charAt(0).toUpperCase()}
                    </span>
                    <span className="text-xs font-bold">{r.author}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Preguntas frecuentes */}
      <section id="faq" className="scroll-mt-24 border-b py-16">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('faqKicker')}
            title={tFaq('title')}
            subtitle={t('faqSubtitle')}
          />
          <div className="space-y-4">
            {faqs.map((f, i) => (
              <details
                key={i}
                className="group rounded-2xl border bg-card p-6 shadow-sm"
                open={i === 0}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-bold marker:content-none">
                  {f.question}
                  <span
                    className="text-xl font-bold transition-transform group-open:rotate-45"
                    style={{ color: brand }}
                    aria-hidden
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 whitespace-pre-line border-t pt-3 text-sm leading-relaxed text-muted-foreground">
                  {f.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Blog */}
      {blogHref && data.latestBlogPosts.length > 0 && (
        <section className="border-b bg-background py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-10 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <Kicker brand={brand}>{t('blogKicker')}</Kicker>
                <h2 className="mt-1 text-2xl font-extrabold sm:text-3xl">{t('blogTitle')}</h2>
              </div>
              <Link
                href={blogHref}
                className="text-sm font-bold hover:underline"
                style={{ color: brand }}
              >
                {t('blogAll')} →
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {data.latestBlogPosts.slice(0, 3).map((p) => (
                <Link
                  key={p.slug}
                  href={buildBlogPostHref(data.tenantSlug, p.slug, locale, data.customDomain)}
                  className="group flex flex-col justify-between overflow-hidden rounded-2xl border bg-muted/40 transition-shadow hover:shadow-md"
                >
                  <div>
                    <div className="relative aspect-video overflow-hidden bg-muted">
                      {p.coverImageUrl ? (
                        <Image
                          src={p.coverImageUrl}
                          alt=""
                          fill
                          loading="lazy"
                          sizes="(min-width: 768px) 33vw, 100vw"
                          className="object-cover transition-transform group-hover:scale-105"
                        />
                      ) : (
                        <div
                          className="h-full w-full"
                          style={{ background: `linear-gradient(135deg, ${brand}22, ${brand}55)` }}
                        />
                      )}
                      <span className="absolute left-3 top-3 rounded-md bg-background/90 px-2.5 py-1 text-[11px] font-bold backdrop-blur">
                        {new Date(p.publishedAt).toLocaleDateString(intlLocaleFor(locale), {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                    <div className="p-6">
                      <h3 className="line-clamp-2 text-lg font-bold">{p.title}</h3>
                    </div>
                  </div>
                  <span
                    className="px-6 pb-6 text-xs font-bold group-hover:underline"
                    style={{ color: brand }}
                  >
                    {t('readMore')} →
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Contacto */}
      {data.contactEnabled && (
        <section id="contacto" className="scroll-mt-24 border-b py-16">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <div className="rounded-3xl border bg-card p-8 shadow-sm sm:p-12">
              <SectionHeading
                brand={brand}
                kicker={t('contactKicker')}
                title={t('contactTitle')}
                subtitle={t('contactSubtitle')}
              />
              <ContactForm slug={data.tenantSlug} brand={brand} />
            </div>
          </div>
        </section>
      )}

      {/* Pie */}
      <footer className="bg-neutral-950 pb-12 pt-14 text-sm text-neutral-400">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-10 border-b border-neutral-800 pb-12 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-4 lg:col-span-2">
              <div className="flex items-center gap-3">
                {data.logoUrl && (
                  <Image
                    src={data.logoUrl}
                    alt=""
                    width={120}
                    height={36}
                    className="h-9 w-auto object-contain brightness-0 invert"
                  />
                )}
                <span className="text-xl font-bold tracking-tight text-white">
                  {data.tenantName}
                </span>
              </div>
              <p className="max-w-sm text-xs leading-relaxed">
                {where ? t('footerTextCity', { where }) : t('footerText')}
              </p>
              <div className="space-y-1 text-xs">
                {phone && (
                  <a href={`tel:${phone}`} className="flex items-center gap-2 hover:text-white">
                    <Phone className="h-3.5 w-3.5" /> {phone}
                  </a>
                )}
                {email && (
                  <a href={`mailto:${email}`} className="flex items-center gap-2 hover:text-white">
                    <Mail className="h-3.5 w-3.5" /> {email}
                  </a>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <h3 className="text-xs font-black uppercase tracking-wider text-white">
                {t('footerNav')}
              </h3>
              <ul className="space-y-2 text-xs">
                {navItems.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => goTo(it.id)}
                      className="transition-colors hover:text-white"
                    >
                      {it.label}
                    </button>
                  </li>
                ))}
                {blogHref && (
                  <li>
                    <Link href={blogHref} className="transition-colors hover:text-white">
                      {t('nav.blog')}
                    </Link>
                  </li>
                )}
              </ul>
            </div>
            <div className="space-y-3">
              <h3 className="text-xs font-black uppercase tracking-wider text-white">
                {t('footerOnline')}
              </h3>
              <ul className="space-y-2 text-xs">
                <li>
                  <Link href={bookHref} className="transition-colors hover:text-white">
                    {t('rentOnline')}
                  </Link>
                </li>
                <li>
                  <Link href={portalHref} className="transition-colors hover:text-white">
                    {t('clientArea')}
                  </Link>
                </li>
                <li>
                  <Link href={portalHref} className="transition-colors hover:text-white">
                    {t('accessCode')}
                  </Link>
                </li>
                <li>
                  <Link href={portalHref} className="transition-colors hover:text-white">
                    {t('invoices')}
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="flex flex-col items-center justify-between gap-4 pt-8 text-xs text-neutral-500 sm:flex-row">
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
      <div className="pb-safe fixed inset-x-0 bottom-0 z-50 flex items-center gap-2 border-t bg-background/95 px-3 py-2.5 shadow-2xl backdrop-blur md:hidden">
        {phone && (
          <a
            href={`tel:${phone}`}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-muted px-3 py-3 text-xs font-bold"
          >
            <Phone className="h-4 w-4" style={{ color: brand }} /> {t('call')}
          </a>
        )}
        {whatsapp && (
          <a
            href={whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent('whatsapp_click')}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-muted px-3 py-3 text-xs font-bold"
          >
            <WhatsAppIcon className="h-4 w-4" style={{ color: brand }} /> WhatsApp
          </a>
        )}
        <Link
          href={bookHref}
          onClick={() => trackEvent('cta_reservar_click', { location: 'mobile_bar_trasteroom' })}
          className="inline-flex flex-[1.4] items-center justify-center gap-1.5 rounded-xl px-4 py-3 text-xs font-black text-white shadow-md"
          style={{ backgroundColor: brand }}
        >
          {t('reserve')} <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

function Kicker({ brand, children }: { brand: string; children: React.ReactNode }) {
  return (
    <p className="text-xs font-black uppercase tracking-widest" style={{ color: brand }}>
      {children}
    </p>
  );
}

function SectionHeading({
  brand,
  kicker,
  title,
  subtitle,
}: {
  brand: string;
  kicker: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mx-auto mb-12 max-w-3xl space-y-3 text-center">
      <Kicker brand={brand}>{kicker}</Kicker>
      <h2 className="text-2xl font-extrabold sm:text-4xl">{title}</h2>
      {subtitle && <p className="text-sm text-muted-foreground sm:text-base">{subtitle}</p>}
    </div>
  );
}

/** Ficha de un centro: datos, contacto, horario y mapa (o foto). */
function FacilityCard({
  f,
  index,
  total,
  brand,
  onShowUnits,
}: {
  f: Facility;
  index: number;
  total: number;
  brand: string;
  onShowUnits: () => void;
}) {
  const t = useTranslations('publicWeb.trasteroom');
  const tHours = useTranslations('publicWeb.hours');
  const tCommon = useTranslations('publicWeb.common');
  const open = isOpenNow(f.openingHours, f.timezone);
  const hasHours = WEEKDAYS.some((d) => f.openingHours[d]);
  const map = mapEmbedUrl(f);
  const image = f.imageUrls[0] ?? null;
  const address = [f.address, [f.postalCode, f.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');

  return (
    <article className="overflow-hidden rounded-3xl border bg-muted/40 shadow-sm">
      <div className="grid lg:grid-cols-12">
        <div className="flex flex-col justify-between p-6 sm:p-8 lg:col-span-5">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className="rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider"
                style={{ backgroundColor: `${brand}1f`, color: brand }}
              >
                {total > 1 && index === 0 ? t('mainCenter') : t('center')}
              </span>
              {hasHours && open != null && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${open ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${open ? 'bg-emerald-500' : 'bg-neutral-400'}`}
                  />
                  {open ? tHours('openNow') : tHours('closedNow')}
                </span>
              )}
            </div>
            <div>
              <h3 className="text-2xl font-black">{f.name}</h3>
              {address && (
                <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" style={{ color: brand }} />
                  <span>{address}</span>
                </p>
              )}
            </div>
            {(f.contactPhone || f.contactEmail) && (
              <div className="space-y-2 border-t pt-3 text-sm">
                {f.contactPhone && (
                  <a
                    href={`tel:${f.contactPhone}`}
                    className="flex items-center gap-2 font-semibold hover:underline"
                  >
                    <Phone className="h-4 w-4" style={{ color: brand }} /> {f.contactPhone}
                  </a>
                )}
                {f.contactEmail && (
                  <a
                    href={`mailto:${f.contactEmail}`}
                    className="flex items-center gap-2 hover:underline"
                  >
                    <Mail className="h-4 w-4" style={{ color: brand }} /> {f.contactEmail}
                  </a>
                )}
              </div>
            )}
            {hasHours && (
              <div className="border-t pt-3">
                <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {t('hoursTitle')}
                </h4>
                <ul className="space-y-0.5 text-xs font-medium">
                  {WEEKDAYS.map((day) => {
                    const h = f.openingHours[day];
                    return (
                      <li key={day} className="flex gap-2">
                        <span className="inline-block w-24 text-muted-foreground">
                          {tHours(day)}
                        </span>
                        <span>{h ? `${h.open}–${h.close}` : tHours('closed')}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 pt-6">
            <button
              type="button"
              onClick={onShowUnits}
              className="flex-1 rounded-xl px-4 py-2.5 text-center text-sm font-bold text-white transition hover:brightness-95"
              style={{ backgroundColor: brand }}
            >
              {t('viewUnits')}
            </button>
            {f.contactPhone && (
              <a
                href={`tel:${f.contactPhone}`}
                className="flex items-center justify-center rounded-xl border bg-card px-3.5 py-2.5 text-sm font-bold hover:bg-muted"
              >
                {t('call')}
              </a>
            )}
          </div>
        </div>

        <div className="relative min-h-[300px] bg-muted lg:col-span-7 lg:min-h-[400px]">
          {map ? (
            <iframe
              src={map}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="absolute inset-0 h-full w-full border-0"
              title={tCommon('mapTitle', { name: f.name })}
            />
          ) : image ? (
            <Image
              src={image}
              alt={f.name}
              fill
              loading="lazy"
              sizes="(min-width: 1024px) 58vw, 100vw"
              className="object-cover"
            />
          ) : (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: `linear-gradient(135deg, ${brand}22, ${brand}55)` }}
            >
              <Warehouse className="h-16 w-16 text-white/80" />
            </div>
          )}
          {f.imageUrls.length > 0 && map && (
            <span className="absolute bottom-3 right-3 rounded-lg bg-black/75 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
              {t('photos', { count: f.imageUrls.length })}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

/** Tarjeta de un tamaño: normal, quedan pocos (≤2) o agotado («Avísame»). */
function UnitTypeCard({
  unit,
  facilityId,
  brand,
  locale,
  tenantSlug,
}: {
  unit: UnitType;
  facilityId: string;
  brand: string;
  locale: PublicWebLocale;
  tenantSlug: string;
}) {
  const t = useTranslations('publicWeb.trasteroom');
  const tCommon = useTranslations('publicWeb.common');
  const soldOut = unit.available <= 0;
  const few = !soldOut && unit.available <= 2;
  const size = sizeOf(unit.areaM2);
  const href = buildBookHref(tenantSlug, locale, {
    facilityId,
    unitTypeId: unit.id,
    ...(soldOut ? { waitlist: true } : {}),
  });

  return (
    <div
      className={`relative flex flex-col justify-between rounded-2xl p-6 transition-colors ${
        soldOut
          ? 'border bg-muted/60'
          : few
            ? 'border-2 border-amber-300 bg-card shadow-md'
            : 'border bg-card shadow-sm'
      }`}
    >
      {few && (
        <span className="absolute -top-3 right-6 rounded-full bg-amber-500 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-white shadow-sm">
          {unit.available === 1
            ? tCommon('urgentOne')
            : tCommon('urgentFew', { count: unit.available })}
        </span>
      )}
      <div>
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            {size && (
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                {t(`size.${size}`)}
              </span>
            )}
            <h3 className={`text-xl font-black ${soldOut ? 'text-muted-foreground' : ''}`}>
              {unit.name}
            </h3>
          </div>
          {unit.areaM2 != null && (
            <span
              className="shrink-0 rounded-xl px-3 py-1 text-sm font-black"
              style={soldOut ? undefined : { backgroundColor: `${brand}1f`, color: brand }}
            >
              {t('m2', { m2: unit.areaM2 })}
            </span>
          )}
        </div>
        <div className="mb-5 flex h-36 w-full items-center justify-center rounded-xl bg-muted">
          {soldOut ? (
            <span className="rounded-md bg-background px-3 py-1 text-xs font-bold text-muted-foreground">
              {t('noRoom')}
            </span>
          ) : (
            <Box className="h-12 w-12 text-muted-foreground/40" />
          )}
        </div>
        {size && <p className="mb-4 text-xs text-muted-foreground">{t(`ideal.${size}`)}</p>}
      </div>

      <div className="space-y-3 border-t pt-4">
        <div className="flex items-baseline justify-between">
          <div>
            <span className={`text-3xl font-black ${soldOut ? 'text-muted-foreground' : ''}`}>
              {formatPrice(unit.priceMonthly * 1.21, locale)}
            </span>
            <span className="text-xs font-medium text-muted-foreground">{t('perMonth')}</span>
          </div>
          <span className="text-[11px] font-semibold text-muted-foreground">{t('vatIncl')}</span>
        </div>
        <p
          className={`flex items-center gap-1 text-xs font-bold ${soldOut ? 'text-rose-600' : few ? 'text-amber-600' : 'text-emerald-600'}`}
        >
          <span
            className={`h-2 w-2 rounded-full ${soldOut ? 'bg-rose-500' : few ? 'animate-ping bg-amber-500' : 'bg-emerald-500'}`}
          />
          {soldOut ? t('soldOutNow') : few ? t('highDemand') : t('availableNow')}
        </p>
        <Link
          href={href}
          onClick={() =>
            !soldOut && trackEvent('cta_reservar_click', { location: 'unit_card_trasteroom' })
          }
          className="inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:brightness-95"
          style={{ backgroundColor: soldOut ? '#262626' : brand }}
        >
          {soldOut ? (
            <>
              <Bell className="mr-2 h-4 w-4" /> {t('notifyMe')}
            </>
          ) : few ? (
            t('reserveBeforeGone')
          ) : (
            t('reserveSize')
          )}
        </Link>
      </div>
    </div>
  );
}

/** Cabecera fija: logo, secciones, área de clientes y «Reservar ahora». */
function Header({
  data,
  brand,
  navItems,
  onNavigate,
  bookHref,
  portalHref,
  blogHref,
}: {
  data: PublicLandingDto;
  brand: string;
  navItems: { id: string; label: string }[];
  onNavigate: (id: string) => void;
  bookHref: string;
  portalHref: string;
  blogHref: string | undefined;
}) {
  const t = useTranslations('publicWeb.trasteroom');
  const [open, setOpen] = useState(false);

  function go(id: string) {
    setOpen(false);
    onNavigate(id);
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-20 items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="flex shrink-0 items-center gap-3"
          >
            {data.logoUrl && (
              <Image
                src={data.logoUrl}
                alt=""
                width={120}
                height={48}
                className="h-10 w-auto object-contain sm:h-12"
              />
            )}
            <span className="text-xl font-extrabold tracking-tight sm:text-2xl">
              {data.tenantName}
            </span>
          </button>

          <nav className="hidden items-center gap-7 text-sm font-semibold text-muted-foreground lg:flex">
            {navItems.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => go(it.id)}
                className="transition-colors hover:text-foreground"
              >
                {it.label}
              </button>
            ))}
            {blogHref && (
              <Link href={blogHref} className="transition-colors hover:text-foreground">
                {t('nav.blog')}
              </Link>
            )}
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <Link
              href={portalHref}
              className="inline-flex items-center gap-1.5 rounded-xl bg-muted px-3.5 py-2 text-sm font-semibold transition-colors hover:bg-muted/70"
            >
              <User className="h-4 w-4 text-muted-foreground" /> {t('clientArea')}
            </Link>
            <Link
              href={bookHref}
              onClick={() => trackEvent('cta_reservar_click', { location: 'header_trasteroom' })}
              className="inline-flex items-center justify-center rounded-xl px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-95 active:scale-95"
              style={{ backgroundColor: brand }}
            >
              {t('reserveNow')}
            </Link>
          </div>

          <div className="flex items-center gap-2 lg:hidden">
            <Link
              href={portalHref}
              className="p-2 text-muted-foreground hover:text-foreground md:hidden"
              aria-label={t('clientArea')}
            >
              <User className="h-6 w-6" />
            </Link>
            <button
              type="button"
              aria-label={open ? t('closeMenu') : t('openMenu')}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="p-2"
            >
              {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {open && (
        <nav className="border-t lg:hidden">
          <div className="mx-auto flex max-w-7xl flex-col px-2 py-2">
            {navItems.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => go(it.id)}
                className="flex items-center justify-between rounded-md px-3 py-3 text-left text-base font-medium hover:bg-muted"
              >
                {it.label}
                <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground" />
              </button>
            ))}
            {blogHref && (
              <Link
                href={blogHref}
                className="rounded-md px-3 py-3 text-base font-medium hover:bg-muted"
              >
                {t('nav.blog')}
              </Link>
            )}
            <Link
              href={portalHref}
              className="rounded-md px-3 py-3 text-base font-medium hover:bg-muted"
            >
              {t('clientArea')}
            </Link>
          </div>
        </nav>
      )}
    </header>
  );
}

function WhatsAppIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} fill="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z" />
    </svg>
  );
}
