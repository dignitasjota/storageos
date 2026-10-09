'use client';

import { mapEmbedUrl, WEEKDAYS } from '@storageos/shared';
import {
  ArrowRight,
  Bell,
  ChevronDown,
  Lock,
  Mail,
  MapPin,
  Menu,
  Phone,
  Smartphone,
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

/** Icono fijo por posición de las tarjetas de ventajas. */
const ADVANTAGE_EMOJIS = ['📱', '📍', '🛡️', '⚡', '🚚', '🗓️'];

type Facility = PublicLandingDto['facilities'][number];
type UnitType = Facility['unitTypes'][number];
type Item = { title: string; text: string };

/** Formato S / M / L orientativo por los m². */
function sizeOf(areaM2: number | null): 'S' | 'M' | 'L' | null {
  if (areaM2 == null) return null;
  if (areaM2 < 3) return 'S';
  if (areaM2 <= 7) return 'M';
  return 'L';
}

function whatsAppHref(phone: string, message: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

/** Botón primario (mayúsculas, como la maqueta). */
const PRIMARY_BTN =
  'inline-flex items-center justify-center rounded-xl text-xs font-extrabold uppercase tracking-wider text-white transition hover:brightness-95 active:scale-95';

/**
 * Plantilla premium «Cabe»: web de una página de estilo urbano y minimalista.
 * Barra de promoción, portada con insignias, ventajas, ficha de cada centro con
 * mapa y horario, formatos S/M/L por centro con disponibilidad, pasos,
 * calculadora, opiniones, preguntas, blog, contacto y barra fija en el móvil.
 * Autocontenida (cabecera y pie propios).
 */
export function CabeTemplate({
  data,
  locale,
}: {
  data: PublicLandingDto;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.cabe');
  const tCommon = useTranslations('publicWeb.common');
  const tFaq = useTranslations('publicWeb.faq');
  const tPromo = useTranslations('publicWeb.promo');

  const brand = data.brandColor ?? '#1E3A8A';
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
  // Insignias de la portada: las «Ventajas» editables (solo título) o las de por defecto.
  const badgesCustom = (content?.advantages ?? []).filter((a) => a.trim());
  const badges: Item[] =
    badgesCustom.length > 0
      ? badgesCustom.map((a) => ({ title: a, text: '' }))
      : (t.raw('badges') as Item[]);
  const advCustom = (content?.services ?? []).filter((s) => s.title.trim());
  const advantages: Item[] =
    advCustom.length > 0
      ? advCustom.map((s) => ({ title: s.title, text: s.text ?? '' }))
      : (t.raw('advantages') as Item[]);
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
    { id: 'ventajas', label: t('nav.advantages') },
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
    <div className="flex min-h-screen flex-col bg-neutral-50 pb-20 text-slate-900 antialiased md:pb-0 dark:bg-background dark:text-foreground">
      <GoogleAnalyticsScript measurementId={data.googleAnalyticsId} />

      {/* Promoción activa */}
      {promo && promoText && (
        <div
          className="px-4 py-2.5 text-xs font-semibold tracking-wide text-white sm:text-sm"
          style={{ backgroundColor: brand }}
        >
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-2 text-center">
            <span className="inline-block rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wider">
              {t('promoTag')}
            </span>
            <span>{promoText}</span>
            <span className="rounded bg-white/20 px-2 py-0.5 font-mono font-bold">
              {promo.code}
            </span>
            <button
              type="button"
              onClick={() => goTo('trasteros')}
              className="ml-1 font-bold underline underline-offset-4 hover:text-white/80"
            >
              {t('promoCta')} →
            </button>
          </div>
        </div>
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
      <section className="relative overflow-hidden border-b border-slate-200 bg-white pb-16 pt-10 dark:border-border dark:bg-card lg:pb-24 lg:pt-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-12">
            <div className="space-y-6 text-center lg:col-span-7 lg:text-left">
              <div
                className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-bold tracking-wide"
                style={{ backgroundColor: `${brand}1f`, color: brand }}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: brand }} />
                {where ? t('badgeCity', { where }) : t('badge')}
              </div>
              <h1 className="text-4xl font-black leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
                {data.webHeadline || headlineFallback}
              </h1>
              <p className="mx-auto max-w-xl text-base leading-relaxed text-slate-600 dark:text-muted-foreground sm:text-xl lg:mx-0">
                {heroSubtitle}
              </p>
              <div className="grid grid-cols-2 gap-3 pt-2 text-left sm:grid-cols-3">
                {badges.slice(0, 3).map((b, i) => (
                  <div
                    key={b.title}
                    className={`rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted ${i === 2 ? 'col-span-2 sm:col-span-1' : ''}`}
                  >
                    <p className="text-xs font-black">{b.title}</p>
                    {b.text && (
                      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground">
                        {b.text}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex flex-col items-center justify-center gap-3 pt-3 sm:flex-row lg:justify-start">
                <Link
                  href={bookHref}
                  onClick={() => trackEvent('cta_reservar_click', { location: 'hero_cabe' })}
                  className={`${PRIMARY_BTN} w-full px-8 py-4 text-sm shadow-lg sm:w-auto`}
                  style={{ backgroundColor: brand }}
                >
                  {t('rentOnline')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
                {whatsapp && (
                  <a
                    href={whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackEvent('whatsapp_click')}
                    className="inline-flex w-full items-center justify-center rounded-xl bg-slate-100 px-6 py-4 text-sm font-bold text-slate-800 transition hover:bg-slate-200 dark:bg-muted dark:text-foreground sm:w-auto"
                  >
                    <WhatsAppIcon className="mr-2 h-4 w-4" style={{ color: brand }} />
                    {t('whatsapp')}
                  </a>
                )}
              </div>
              {data.googleReviewUrl && (
                <div className="flex items-center justify-center gap-3 pt-2 lg:justify-start">
                  <span className="text-sm font-bold tracking-widest text-amber-500">★★★★★</span>
                  <a
                    href={data.googleReviewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-bold text-slate-600 underline underline-offset-4 hover:opacity-80 dark:text-muted-foreground"
                  >
                    {t('googleReviews')}
                  </a>
                </div>
              )}
            </div>

            <div className="relative lg:col-span-5">
              <div className="relative mx-auto aspect-[4/3] overflow-hidden rounded-3xl border border-slate-200 bg-slate-100 shadow-xl dark:border-border lg:aspect-square">
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
                    style={{ background: `linear-gradient(135deg, ${brand}, ${brand}99)` }}
                  >
                    <Warehouse className="h-24 w-24 text-white/80" />
                  </div>
                )}
                <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-slate-200/80 bg-white/95 p-4 shadow-md backdrop-blur-md dark:border-border dark:bg-background/95">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                        {t('heroCardKicker')}
                      </p>
                      <p className="text-sm font-extrabold">{t('heroCardText')}</p>
                    </div>
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-white"
                      style={{ backgroundColor: brand }}
                    >
                      <Smartphone className="h-5 w-5" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Sobre nosotros */}
      {data.webAbout && (
        <section className="border-b border-slate-200 bg-slate-50 py-14 dark:border-border dark:bg-muted/40">
          <div className="mx-auto max-w-4xl space-y-4 px-4 text-center sm:px-6 lg:px-8">
            <Kicker brand={brand}>{t('aboutKicker')}</Kicker>
            <h2 className="text-2xl font-black sm:text-3xl">
              {t('aboutTitle', { tenantName: data.tenantName })}
            </h2>
            <p className="whitespace-pre-line text-base leading-relaxed text-slate-600 dark:text-muted-foreground sm:text-lg">
              {data.webAbout}
            </p>
          </div>
        </section>
      )}

      {/* Ventajas */}
      <section
        id="ventajas"
        className="scroll-mt-24 border-b border-slate-200 bg-white py-16 dark:border-border dark:bg-card"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('advantagesKicker')}
            title={t('advantagesTitle')}
            subtitle={t('advantagesSubtitle')}
          />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {advantages.map((a, i) => (
              <div
                key={a.title}
                className="rounded-2xl border border-slate-200 bg-neutral-50 p-6 transition-colors dark:border-border dark:bg-muted/40"
              >
                <div
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-lg"
                  style={{ backgroundColor: `${brand}1f` }}
                  aria-hidden
                >
                  {ADVANTAGE_EMOJIS[i % ADVANTAGE_EMOJIS.length]}
                </div>
                <h3 className="mb-2 text-lg font-black">{a.title}</h3>
                <p className="whitespace-pre-line text-xs leading-relaxed text-slate-600 dark:text-muted-foreground sm:text-sm">
                  {a.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Centros */}
      <section
        id="locales"
        className="scroll-mt-24 border-b border-slate-200 py-16 dark:border-border"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('centersKicker')}
            title={t('centersTitle')}
            subtitle={t('centersSubtitle')}
          />
          <div className="space-y-10">
            {data.facilities.map((f) => (
              <FacilityCard key={f.id} f={f} brand={brand} onShowUnits={() => showUnitsOf(f.id)} />
            ))}
          </div>
        </div>
      </section>

      {/* Formatos y tarifas por centro */}
      <section
        id="trasteros"
        className="scroll-mt-24 border-b border-slate-200 bg-white py-16 dark:border-border dark:bg-card"
      >
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
                    className={`shrink-0 rounded-xl border px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider transition ${active ? 'text-white shadow-sm' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-border dark:bg-muted dark:text-foreground'}`}
                    style={active ? { backgroundColor: brand, borderColor: brand } : undefined}
                  >
                    {f.city && f.city !== f.name ? `${f.name} · ${f.city}` : f.name}
                  </button>
                );
              })}
            </div>
          )}
          {facilityForUnits && facilityForUnits.unitTypes.length > 0 ? (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
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
            <p className="rounded-3xl border border-slate-200 bg-neutral-50 px-4 py-10 text-center text-slate-500 dark:border-border dark:bg-muted/40">
              {t('noUnits')}
            </p>
          )}
        </div>
      </section>

      {/* Cómo funciona */}
      <section
        id="como-funciona"
        className="scroll-mt-24 border-b border-slate-200 py-16 dark:border-border"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('stepsKicker')}
            title={t('stepsTitle')}
            subtitle={t('stepsSubtitle')}
          />
          <ol className="grid grid-cols-1 gap-6 md:grid-cols-4">
            {steps.map((s, i) => (
              <li
                key={s.title}
                className="space-y-3 rounded-2xl border border-slate-200 bg-white p-6 dark:border-border dark:bg-card"
              >
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-sm font-black text-white"
                  style={{ backgroundColor: brand }}
                >
                  {i + 1}
                </div>
                <h3 className="text-base font-black">{s.title}</h3>
                <p className="text-xs leading-relaxed text-slate-600 dark:text-muted-foreground">
                  {s.text}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Calculadora */}
      <section
        id="calculadora"
        className="scroll-mt-24 border-b border-slate-200 bg-white py-16 dark:border-border dark:bg-card"
      >
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="mb-6 text-center">
            <Kicker brand={brand}>{t('calculatorKicker')}</Kicker>
          </div>
          <StorageCalculator data={data} brand={brand} locale={locale} />
        </div>
      </section>

      {/* Opiniones */}
      {data.testimonials.length > 0 && (
        <section className="border-b border-slate-200 py-16 dark:border-border">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-10 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <Kicker brand={brand}>{t('reviewsKicker')}</Kicker>
                <h2 className="mt-1 text-2xl font-black sm:text-3xl">{t('reviewsTitle')}</h2>
              </div>
              {data.googleReviewUrl && (
                <a
                  href={data.googleReviewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-bold hover:underline"
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
                  className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 dark:border-border dark:bg-card"
                >
                  <div className="space-y-3">
                    <div className="text-sm text-amber-400">
                      {'★'.repeat(Math.max(1, Math.min(5, r.rating ?? 5)))}
                    </div>
                    <blockquote className="text-xs italic leading-relaxed text-slate-700 dark:text-foreground sm:text-sm">
                      “{r.comment}”
                    </blockquote>
                  </div>
                  <figcaption className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 dark:border-border">
                    <span className="text-xs font-black">{r.author}</span>
                    {r.rating != null && (
                      <span className="font-mono text-[11px] font-bold text-slate-500 dark:text-muted-foreground">
                        {r.rating} / 5
                      </span>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Preguntas frecuentes */}
      <section
        id="faq"
        className="scroll-mt-24 border-b border-slate-200 bg-white py-16 dark:border-border dark:bg-card"
      >
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <SectionHeading
            brand={brand}
            kicker={t('faqKicker')}
            title={tFaq('title')}
            subtitle={t('faqSubtitle')}
          />
          <div className="space-y-3">
            {faqs.map((f, i) => (
              <details
                key={i}
                className="group rounded-2xl border border-slate-200 bg-neutral-50 p-6 dark:border-border dark:bg-muted/40"
                open={i === 0}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-black marker:content-none sm:text-base">
                  {f.question}
                  <span
                    className="text-lg font-black transition-transform group-open:rotate-45"
                    style={{ color: brand }}
                    aria-hidden
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 whitespace-pre-line border-t border-slate-200/80 pt-3 text-xs leading-relaxed text-slate-600 dark:border-border dark:text-muted-foreground sm:text-sm">
                  {f.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Blog */}
      {blogHref && data.latestBlogPosts.length > 0 && (
        <section className="border-b border-slate-200 py-16 dark:border-border">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-10 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <Kicker brand={brand}>{t('blogKicker')}</Kicker>
                <h2 className="mt-1 text-2xl font-black sm:text-3xl">{t('blogTitle')}</h2>
              </div>
              <Link
                href={blogHref}
                className="text-xs font-bold hover:underline"
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
                  className="group flex flex-col justify-between overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-border dark:bg-card"
                >
                  <div>
                    <div className="relative aspect-video overflow-hidden bg-slate-200 dark:bg-muted">
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
                      <span className="absolute left-3 top-3 rounded bg-white/90 px-2 py-0.5 text-[11px] font-bold text-slate-900 backdrop-blur">
                        {new Date(p.publishedAt).toLocaleDateString(intlLocaleFor(locale), {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                    <div className="p-6">
                      <h3 className="line-clamp-2 text-base font-black">{p.title}</h3>
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
        <section
          id="contacto"
          className="scroll-mt-24 border-b border-slate-200 bg-white py-16 dark:border-border dark:bg-card"
        >
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <div className="rounded-3xl border border-slate-200 bg-neutral-50 p-8 shadow-sm dark:border-border dark:bg-muted/40 sm:p-12">
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
      <footer className="bg-slate-900 pb-12 pt-14 text-xs text-slate-400">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-10 border-b border-slate-800 pb-12 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-4 lg:col-span-2">
              <div className="flex items-center gap-3">
                {data.logoUrl && (
                  <Image
                    src={data.logoUrl}
                    alt=""
                    width={110}
                    height={32}
                    className="h-8 w-auto object-contain brightness-0 invert"
                  />
                )}
                <span className="text-xl font-extrabold tracking-tight text-white">
                  {data.tenantName}
                </span>
              </div>
              <p className="max-w-sm leading-relaxed">
                {where ? t('footerTextCity', { where }) : t('footerText')}
              </p>
              <div className="space-y-1">
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
                {data.googleReviewUrl && (
                  <a
                    href={data.googleReviewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block hover:text-white"
                  >
                    {t('googleReviewsShort')}
                  </a>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <h3 className="text-xs font-black uppercase tracking-wider text-white">
                {t('footerCenters')}
              </h3>
              <ul className="space-y-2">
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
                {t('footerManage')}
              </h3>
              <ul className="space-y-2">
                <li>
                  <Link href={bookHref} className="transition-colors hover:text-white">
                    {t('rentOnlineShort')}
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
          <div className="flex flex-col items-center justify-between gap-4 pt-8 text-slate-500 sm:flex-row">
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
      <div className="pb-safe fixed inset-x-0 bottom-0 z-50 flex items-center gap-2 border-t border-slate-200 bg-white/95 px-3 py-2.5 shadow-2xl backdrop-blur-md dark:border-border dark:bg-background/95 md:hidden">
        {phone && (
          <a
            href={`tel:${phone}`}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-3 py-3 text-xs font-bold text-slate-800 dark:bg-muted dark:text-foreground"
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
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-100 px-3 py-3 text-xs font-bold text-slate-800 dark:bg-muted dark:text-foreground"
          >
            <WhatsAppIcon className="h-4 w-4" style={{ color: brand }} /> WhatsApp
          </a>
        )}
        <Link
          href={bookHref}
          onClick={() => trackEvent('cta_reservar_click', { location: 'mobile_bar_cabe' })}
          className={`${PRIMARY_BTN} flex-[1.4] gap-1.5 px-4 py-3 shadow-md`}
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
      <h2 className="text-2xl font-black sm:text-4xl">{title}</h2>
      {subtitle && (
        <p className="text-sm text-slate-600 dark:text-muted-foreground sm:text-base">{subtitle}</p>
      )}
    </div>
  );
}

/** Ficha de un centro: datos, contacto, horario de acceso y mapa (o foto). */
function FacilityCard({
  f,
  brand,
  onShowUnits,
}: {
  f: Facility;
  brand: string;
  onShowUnits: () => void;
}) {
  const t = useTranslations('publicWeb.cabe');
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
    <article className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card">
      <div className="grid lg:grid-cols-12">
        <div className="flex flex-col justify-between p-6 sm:p-8 lg:col-span-5">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="rounded-md bg-slate-100 px-3 py-1 text-[11px] font-extrabold uppercase tracking-wider text-slate-700 dark:bg-muted dark:text-foreground">
                {f.city || t('center')}
              </span>
              {hasHours && open != null && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${open ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-200 text-slate-700 dark:bg-muted dark:text-muted-foreground'}`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${open ? 'bg-emerald-600' : 'bg-slate-400'}`}
                  />
                  {open ? tHours('openNow') : tHours('closedNow')}
                </span>
              )}
            </div>
            <div>
              <h3 className="text-2xl font-black">{f.name}</h3>
              {address && (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-600 dark:text-muted-foreground sm:text-sm">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" style={{ color: brand }} />
                  <span>{address}</span>
                </p>
              )}
            </div>
            {(f.contactPhone || f.contactEmail) && (
              <div className="space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-700 dark:border-border dark:text-foreground sm:text-sm">
                {f.contactPhone && (
                  <a
                    href={`tel:${f.contactPhone}`}
                    className="flex items-center gap-2 font-bold hover:underline"
                  >
                    <Phone className="h-4 w-4" style={{ color: brand }} /> {f.contactPhone}
                  </a>
                )}
                {f.contactEmail && (
                  <a
                    href={`mailto:${f.contactEmail}`}
                    className="flex items-center gap-2 font-medium hover:underline"
                  >
                    <Mail className="h-4 w-4" style={{ color: brand }} /> {f.contactEmail}
                  </a>
                )}
              </div>
            )}
            {hasHours && (
              <div className="border-t border-slate-100 pt-3 dark:border-border">
                <p className="mb-1 text-[11px] font-black uppercase tracking-wider text-slate-400">
                  {t('hoursTitle')}
                </p>
                <ul className="space-y-0.5 text-xs text-slate-700 dark:text-foreground">
                  {WEEKDAYS.map((day) => {
                    const h = f.openingHours[day];
                    return (
                      <li key={day} className="flex gap-2">
                        <span className="inline-block w-24 text-slate-500 dark:text-muted-foreground">
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
              className={`${PRIMARY_BTN} flex-1 px-4 py-3`}
              style={{ backgroundColor: brand }}
            >
              {t('viewUnits')}
            </button>
            {f.contactPhone && (
              <a
                href={`tel:${f.contactPhone}`}
                className="rounded-xl bg-slate-100 px-4 py-3 text-xs font-bold text-slate-800 transition hover:bg-slate-200 dark:bg-muted dark:text-foreground"
              >
                {t('call')}
              </a>
            )}
          </div>
        </div>

        <div className="relative min-h-[320px] bg-slate-200 dark:bg-muted lg:col-span-7">
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
              style={{ background: `linear-gradient(135deg, ${brand}22, ${brand}66)` }}
            >
              <Warehouse className="h-16 w-16 text-white/80" />
            </div>
          )}
          {f.imageUrls.length > 0 && map && (
            <span className="absolute bottom-3 right-3 rounded-md bg-slate-900/80 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur">
              {t('photos', { count: f.imageUrls.length })}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

/** Tarjeta de un formato: normal, quedan pocos (≤2) o agotado («Avísame»). */
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
  const t = useTranslations('publicWeb.cabe');
  const tCommon = useTranslations('publicWeb.common');
  const soldOut = unit.available <= 0;
  const few = !soldOut && unit.available <= 2;
  const size = sizeOf(unit.areaM2);
  const href = buildBookHref(tenantSlug, locale, {
    facilityId,
    unitTypeId: unit.id,
    ...(soldOut ? { waitlist: true } : {}),
  });
  const m2 = unit.areaM2 != null ? String(unit.areaM2).replace('.', ',') : null;

  return (
    <div
      className={`relative flex flex-col justify-between rounded-3xl p-6 transition-colors sm:p-7 ${
        soldOut
          ? 'border border-slate-200 bg-slate-100/70 dark:border-border dark:bg-muted/60'
          : few
            ? 'border-2 border-amber-400 bg-white shadow-md dark:bg-card'
            : 'border border-slate-200 bg-neutral-50 dark:border-border dark:bg-muted/40'
      }`}
    >
      {few && (
        <span className="absolute -top-3.5 right-6 rounded-full bg-amber-500 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-white shadow-sm">
          {unit.available === 1
            ? tCommon('urgentOne')
            : tCommon('urgentFew', { count: unit.available })}
        </span>
      )}
      <div>
        <div className="mb-4 flex items-center justify-between gap-2">
          {size ? (
            <span
              className={`rounded px-2.5 py-1 text-[11px] font-black uppercase tracking-wider ${few ? 'bg-amber-100 text-amber-900' : 'bg-slate-200 text-slate-800 dark:bg-muted dark:text-foreground'}`}
            >
              {t('size', { size })}
            </span>
          ) : (
            <span />
          )}
          {m2 && (
            <span
              className="rounded-lg px-3 py-1 text-sm font-black"
              style={soldOut ? undefined : { backgroundColor: `${brand}1f`, color: brand }}
            >
              {m2} m²
            </span>
          )}
        </div>
        <h3
          className={`mb-2 text-xl font-black ${soldOut ? 'text-slate-500 dark:text-muted-foreground' : ''}`}
        >
          {unit.name}
        </h3>
        <div className="flex items-center justify-center py-6">
          <div
            className={`flex h-24 w-24 flex-col items-center justify-center rounded-2xl border ${few ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 bg-white text-slate-400 dark:border-border dark:bg-card'}`}
          >
            {m2 ? (
              <>
                <span
                  className={`text-2xl font-black ${few ? '' : soldOut ? '' : 'text-slate-800 dark:text-foreground'}`}
                >
                  {m2}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider">
                  {t('metres')}
                </span>
              </>
            ) : soldOut ? (
              <Lock className="h-8 w-8" />
            ) : (
              <Warehouse className="h-8 w-8" />
            )}
          </div>
        </div>
        {size && (
          <p className="mb-6 text-xs leading-relaxed text-slate-600 dark:text-muted-foreground">
            {t(`ideal.${size}`)}
          </p>
        )}
      </div>

      <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-border">
        <div className="flex items-baseline justify-between">
          <div>
            <span
              className={`text-3xl font-black ${soldOut ? 'text-slate-500 dark:text-muted-foreground' : ''}`}
            >
              {formatPrice(unit.priceMonthly * 1.21, locale)}
            </span>
            <span className="text-xs font-semibold text-slate-500">{t('perMonth')}</span>
          </div>
          <span className="text-[11px] font-bold text-slate-400">{t('vatIncl')}</span>
        </div>
        <div
          className={`flex items-center gap-1.5 text-xs font-bold ${soldOut ? 'text-rose-700' : few ? 'text-amber-700' : 'text-emerald-700'}`}
        >
          <span
            className={`h-2 w-2 rounded-full ${soldOut ? 'bg-rose-500' : few ? 'bg-amber-500' : 'bg-emerald-500'}`}
          />
          {soldOut ? t('soldOutHere') : few ? t('almostGone') : t('availableNow')}
        </div>
        <Link
          href={href}
          onClick={() =>
            !soldOut && trackEvent('cta_reservar_click', { location: 'unit_card_cabe' })
          }
          className={`${PRIMARY_BTN} w-full px-4 py-3.5`}
          style={{ backgroundColor: soldOut ? '#1e293b' : brand }}
        >
          {soldOut ? (
            <>
              <Bell className="mr-2 h-4 w-4" /> {t('notifyMe')}
            </>
          ) : few ? (
            t('reserveSpot')
          ) : (
            t('rentThis')
          )}
        </Link>
      </div>
    </div>
  );
}

/** Cabecera fija minimalista: logo, secciones, área de clientes y «Reservar». */
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
  const t = useTranslations('publicWeb.cabe');
  const [open, setOpen] = useState(false);

  function go(id: string) {
    setOpen(false);
    onNavigate(id);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur-md dark:border-border dark:bg-background/95">
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
                width={110}
                height={40}
                className="h-10 w-auto object-contain"
              />
            )}
            <span className="text-2xl font-extrabold tracking-tight">{data.tenantName}</span>
          </button>

          <nav className="hidden items-center gap-6 text-sm font-bold text-slate-600 dark:text-muted-foreground xl:flex xl:gap-8">
            {navItems.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => go(it.id)}
                className="transition-colors hover:opacity-80"
              >
                {it.label}
              </button>
            ))}
            {blogHref && (
              <Link href={blogHref} className="transition-colors hover:opacity-80">
                {t('nav.blog')}
              </Link>
            )}
          </nav>

          <div className="hidden items-center gap-3 md:flex">
            <Link
              href={portalHref}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-200 dark:bg-muted dark:text-foreground"
            >
              <Lock className="h-4 w-4 text-slate-500" /> {t('clientArea')}
            </Link>
            <Link
              href={bookHref}
              onClick={() => trackEvent('cta_reservar_click', { location: 'header_cabe' })}
              className={`${PRIMARY_BTN} px-5 py-2.5 shadow-sm`}
              style={{ backgroundColor: brand }}
            >
              {t('reserve')}
            </Link>
          </div>

          <div className="flex items-center gap-3 xl:hidden">
            <Link
              href={portalHref}
              className="p-2 text-slate-700 dark:text-foreground md:hidden"
              aria-label={t('clientArea')}
            >
              <User className="h-6 w-6" />
            </Link>
            <button
              type="button"
              aria-label={open ? t('closeMenu') : t('openMenu')}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="p-2 text-slate-800 dark:text-foreground"
            >
              {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {open && (
        <nav className="border-t border-slate-200 dark:border-border xl:hidden">
          <div className="mx-auto flex max-w-7xl flex-col px-2 py-2">
            {navItems.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => go(it.id)}
                className="flex items-center justify-between rounded-md px-3 py-3 text-left text-base font-bold hover:bg-slate-100 dark:hover:bg-muted"
              >
                {it.label}
                <ChevronDown className="h-4 w-4 -rotate-90 text-slate-400" />
              </button>
            ))}
            {blogHref && (
              <Link
                href={blogHref}
                className="rounded-md px-3 py-3 text-base font-bold hover:bg-slate-100 dark:hover:bg-muted"
              >
                {t('nav.blog')}
              </Link>
            )}
            <Link
              href={portalHref}
              className="rounded-md px-3 py-3 text-base font-bold hover:bg-slate-100 dark:hover:bg-muted"
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
