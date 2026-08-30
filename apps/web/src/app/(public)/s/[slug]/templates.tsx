'use client';

import { mapEmbedUrl, WEEKDAYS } from '@storageos/shared';
import { Clock, MapPin, MessageCircle, Phone, Mail, Star, Quote } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ContactForm } from './contact-form';
import { trackEvent } from './google-analytics';
import { bookHref, type PublicWebLocale } from './i18n/messages';
import { formatPrice } from './price-format';
import { StorageCalculator } from './storage-calculator';

import type { OpeningHours, PublicLandingDto, Weekday } from '@storageos/shared';

export { formatPrice, priceRangeString } from './price-format';

export function cities(data: PublicLandingDto): string {
  const set = [...new Set(data.facilities.map((f) => f.city).filter(Boolean))] as string[];
  return set.join(', ');
}

interface TplProps {
  data: PublicLandingDto;
  locale: PublicWebLocale;
}

/** Selecciona la plantilla de la web pública según `data.webTemplate`. */
export function LandingTemplate({ data, locale }: TplProps) {
  switch (data.webTemplate) {
    case 'modern':
      return <ModernTemplate data={data} locale={locale} />;
    case 'industrial':
      return <IndustrialTemplate data={data} locale={locale} />;
    default:
      return <DefaultTemplate data={data} locale={locale} />;
  }
}

export function FacilityMeta({
  f,
  tenantName,
}: {
  f: PublicLandingDto['facilities'][number];
  tenantName: string;
}) {
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        {(f.address || f.city) && (
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="h-4 w-4" />
            {[f.address, f.postalCode, f.city].filter(Boolean).join(', ')}
          </span>
        )}
        {f.contactPhone && (
          <a
            href={`tel:${f.contactPhone}`}
            className="inline-flex items-center gap-1.5 hover:text-foreground"
          >
            <Phone className="h-4 w-4" /> {f.contactPhone}
          </a>
        )}
        {f.contactEmail && (
          <a
            href={`mailto:${f.contactEmail}`}
            className="inline-flex items-center gap-1.5 hover:text-foreground"
          >
            <Mail className="h-4 w-4" /> {f.contactEmail}
          </a>
        )}
        {f.contactPhone && <WhatsAppButton phone={f.contactPhone} tenantName={tenantName} />}
      </div>
      <OpeningHoursInfo hours={f.openingHours} timezone={f.timezone} />
      <FacilityMap f={f} />
    </div>
  );
}

/** Mapa embebido (sin API key) a partir de coordenadas o, si no hay, de la dirección de texto. */
export function FacilityMap({ f }: { f: PublicLandingDto['facilities'][number] }) {
  const t = useTranslations('publicWeb.common');
  const src = mapEmbedUrl(f);
  if (!src) return null;
  return (
    <iframe
      src={src}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
      className="aspect-video w-full rounded-md border"
      title={t('mapTitle', { name: f.name })}
    />
  );
}

// ============================================================================
// WhatsApp + horario de apertura
// ============================================================================

function whatsAppHref(phone: string, message: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function WhatsAppButton({ phone, tenantName }: { phone: string; tenantName: string }) {
  const t = useTranslations('publicWeb.common');
  const href = whatsAppHref(phone, t('whatsappPrefill', { tenantName }));
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackEvent('whatsapp_click')}
      className="inline-flex items-center gap-1.5 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
    >
      <MessageCircle className="h-4 w-4" /> {t('whatsapp')}
    </a>
  );
}

const WEEKDAY_INTL_SHORT: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

/** `true`/`false` si se pudo calcular con la `timezone` del local, `null` si no. */
function isOpenNow(hours: OpeningHours, timezone: string): boolean | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const weekdayShort = parts.find((p) => p.type === 'weekday')?.value;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    const day = weekdayShort ? WEEKDAY_INTL_SHORT[weekdayShort] : undefined;
    if (!day || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    const today = hours[day];
    if (!today) return false;
    const [openH, openM] = today.open.split(':').map(Number);
    const [closeH, closeM] = today.close.split(':').map(Number);
    const nowMin = hour * 60 + minute;
    return nowMin >= openH! * 60 + openM! && nowMin < closeH! * 60 + closeM!;
  } catch {
    return null;
  }
}

/** Horario semanal desplegable + indicador "abierto ahora" (calculado en la zona horaria del local). */
export function OpeningHoursInfo({ hours, timezone }: { hours: OpeningHours; timezone: string }) {
  const t = useTranslations('publicWeb.hours');
  const hasAny = WEEKDAYS.some((d) => hours[d]);
  if (!hasAny) return null;
  const open = isOpenNow(hours, timezone);
  return (
    <details className="group w-fit text-sm text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 marker:content-none">
        <Clock className="h-4 w-4" />
        {t('title')}
        {open != null && (
          <span
            className={
              open ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
            }
          >
            · {open ? t('openNow') : t('closedNow')}
          </span>
        )}
      </summary>
      <ul className="mt-1.5 space-y-0.5 pl-6 text-xs">
        {WEEKDAYS.map((day) => {
          const dayHours = hours[day];
          return (
            <li key={day} className="flex gap-2">
              <span className="inline-block w-24">{t(day)}</span>
              <span>{dayHours ? `${dayHours.open}–${dayHours.close}` : t('closed')}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Umbral de "quedan pocos": ≤N unidades disponibles se destaca como urgencia. */
const URGENCY_THRESHOLD = 2;

export function isUrgentStock(available: number): boolean {
  return available > 0 && available <= URGENCY_THRESHOLD;
}

export function UnitTypeList({
  f,
  locale,
}: {
  f: PublicLandingDto['facilities'][number];
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.common');
  if (f.unitTypes.length === 0) {
    return <p className="mt-4 text-sm text-muted-foreground">{t('noAvailabilityShort')}</p>;
  }
  return (
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">
      {f.unitTypes.map((unitType) => {
        const soldOut = unitType.available === 0;
        const urgent = isUrgentStock(unitType.available);
        return (
          <li
            key={unitType.id}
            className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
              soldOut ? 'opacity-60' : ''
            }`}
          >
            <span>
              <span className="font-medium">{unitType.name}</span>
              <span
                className={`ml-2 text-xs ${
                  soldOut
                    ? 'font-medium text-destructive'
                    : urgent
                      ? 'font-semibold text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground'
                }`}
              >
                {soldOut
                  ? t('soldOut')
                  : unitType.available === 1
                    ? t('urgentOne')
                    : urgent
                      ? t('urgentFew', { count: unitType.available })
                      : t('availableMany', { count: unitType.available })}
              </span>
            </span>
            <span className="font-semibold">
              {t('from')} {formatPrice(unitType.priceMonthly * 1.21, locale)}
              <span className="text-xs font-normal text-muted-foreground">
                {t('perMonthVatIncl')}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ============================================================================
// Estándar (default) — la plantilla original, centrada y limpia
// ============================================================================

/** Titular por defecto (sin `webHeadline` propio del tenant) según el idioma. */
export function useHeadlineFallback(where: string): string {
  const t = useTranslations('publicWeb.common');
  return where ? t('headlineWithCity', { city: where }) : t('headlineDefault');
}

function DefaultTemplate({ data, locale }: TplProps) {
  const where = cities(data);
  const headline = useHeadlineFallback(where);
  const t = useTranslations('publicWeb.default');
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <header className="mb-10 text-center">
        {data.logoUrl && (
          <Image
            src={data.logoUrl}
            alt={data.tenantName}
            width={200}
            height={56}
            className="mx-auto mb-6 h-14 w-auto object-contain"
          />
        )}
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {data.webHeadline || headline}
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          {t('subtitle', { tenantName: data.tenantName })}
        </p>
        <ReserveButton data={data} locale={locale} />
      </header>

      <PromoBanner data={data} />
      <TrustBar data={data} />

      {data.webAbout && (
        <section className="mb-10 whitespace-pre-line rounded-lg border bg-card p-6 text-center text-sm leading-relaxed text-muted-foreground">
          {data.webAbout}
        </section>
      )}

      <FacilitiesGrid data={data} locale={locale} />
      <ExtraSections data={data} locale={locale} />
    </div>
  );
}

// ============================================================================
// Moderna — hero a color de marca a pantalla, tarjetas de local
// ============================================================================

function ModernTemplate({ data, locale }: TplProps) {
  const where = cities(data);
  const headline = useHeadlineFallback(where);
  const t = useTranslations('publicWeb');
  const brand = data.brandColor ?? '#2563EB';
  return (
    <div>
      <header
        className="px-4 py-16 text-center text-white sm:py-24"
        style={{ background: `linear-gradient(135deg, ${brand}, ${brand}cc)` }}
      >
        {data.logoUrl && (
          <Image
            src={data.logoUrl}
            alt={data.tenantName}
            width={220}
            height={64}
            className="mx-auto mb-6 h-16 w-auto object-contain drop-shadow"
          />
        )}
        <h1 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
          {data.webHeadline || headline}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg opacity-90">
          {t('modern.subtitle', { tenantName: data.tenantName })}
        </p>
        <Link
          href={bookHref(data.tenantSlug, locale)}
          onClick={() => trackEvent('cta_reservar_click', { location: 'hero_modern' })}
          className="mt-8 inline-flex h-12 items-center rounded-full bg-white px-8 text-sm font-semibold shadow-lg transition-transform hover:scale-105"
          style={{ color: brand }}
        >
          {t('common.reserveNow')}
        </Link>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-12">
        <PromoBanner data={data} />
        <TrustBar data={data} />
        {data.webAbout && (
          <section className="mb-12 whitespace-pre-line text-center text-base leading-relaxed text-muted-foreground">
            {data.webAbout}
          </section>
        )}
        <FacilitiesGrid data={data} locale={locale} cols />
        <ExtraSections data={data} locale={locale} />
      </div>
    </div>
  );
}

// ============================================================================
// Industrial — tonos oscuros, tipografía marcada
// ============================================================================

function IndustrialTemplate({ data, locale }: TplProps) {
  const where = cities(data);
  const headline = useHeadlineFallback(where);
  const t = useTranslations('publicWeb');
  const brand = data.brandColor ?? '#f59e0b';
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-4xl">
          {data.logoUrl && (
            <Image
              src={data.logoUrl}
              alt={data.tenantName}
              width={170}
              height={48}
              className="mb-6 h-12 w-auto object-contain"
            />
          )}
          <p className="text-sm font-semibold uppercase tracking-widest" style={{ color: brand }}>
            {data.tenantName}
          </p>
          <h1 className="mt-3 text-4xl font-black uppercase tracking-tight sm:text-6xl">
            {data.webHeadline || headline}
          </h1>
          <p className="mt-4 max-w-xl text-lg text-neutral-400">{t('industrial.subtitle')}</p>
          <Link
            href={bookHref(data.tenantSlug, locale)}
            onClick={() => trackEvent('cta_reservar_click', { location: 'hero_industrial' })}
            className="mt-8 inline-flex h-12 items-center px-8 text-sm font-bold uppercase tracking-wider text-neutral-950 transition-opacity hover:opacity-90"
            style={{ backgroundColor: brand }}
          >
            {t('common.reserveNow')}
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-12">
        <PromoBanner data={data} />
        <TrustBar data={data} textClassName="text-neutral-400" />
        {data.webAbout && (
          <section
            className="mb-12 whitespace-pre-line border-l-2 pl-4 text-base leading-relaxed text-neutral-400"
            style={{ borderColor: brand }}
          >
            {data.webAbout}
          </section>
        )}
        <div className="space-y-6">
          {data.facilities.map((f, index) => (
            <section
              key={f.id}
              className="overflow-hidden border border-neutral-800 bg-neutral-900"
            >
              {f.imageUrls[0] && (
                <div className="relative aspect-[16/9] w-full bg-neutral-800">
                  <Image
                    src={f.imageUrls[0]}
                    alt={f.name}
                    fill
                    {...(index === 0 ? { priority: true } : { loading: 'lazy' as const })}
                    sizes="(min-width: 768px) 50vw, 100vw"
                    className="object-cover"
                  />
                </div>
              )}
              <div className="p-6">
                <h2 className="text-xl font-bold uppercase tracking-wide">{f.name}</h2>
                <FacilityMeta f={f} tenantName={data.tenantName} />
                <UnitTypeList f={f} locale={locale} />
                <Link
                  href={
                    f.publicSlug
                      ? `/s/${data.tenantSlug}/${f.publicSlug}`
                      : bookHref(data.tenantSlug, locale, { facilityId: f.id })
                  }
                  className="mt-4 inline-flex h-10 items-center border border-neutral-700 px-4 text-sm font-semibold uppercase tracking-wider transition-colors hover:bg-neutral-800"
                >
                  {f.publicSlug
                    ? t('common.viewFacility', { name: f.name })
                    : t('common.reserveAtFacility', { name: f.name })}
                </Link>
              </div>
            </section>
          ))}
        </div>
        <ExtraSections data={data} locale={locale} />
      </div>
    </div>
  );
}

// ============================================================================
// Piezas compartidas
// ============================================================================

function ReserveButton({ data, locale }: { data: PublicLandingDto; locale: PublicWebLocale }) {
  const t = useTranslations('publicWeb.common');
  return (
    <Link
      href={bookHref(data.tenantSlug, locale)}
      onClick={() => trackEvent('cta_reservar_click', { location: 'hero_default' })}
      className="mt-6 inline-flex h-11 items-center rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
      style={{ backgroundColor: data.brandColor ?? 'hsl(var(--primary))' }}
    >
      {t('reserveNow')}
    </Link>
  );
}

function FacilitiesGrid({ data, locale, cols }: TplProps & { cols?: boolean }) {
  const t = useTranslations('publicWeb.common');
  if (data.facilities.length === 0) {
    return (
      <p className="rounded-md border bg-card px-4 py-10 text-center text-muted-foreground">
        {t('noAvailabilityLong')}
      </p>
    );
  }
  return (
    <div className={cols ? 'grid gap-6 md:grid-cols-2' : 'space-y-6'}>
      {data.facilities.map((f, index) => (
        <section key={f.id} className="overflow-hidden rounded-lg border bg-card shadow-sm">
          {f.imageUrls[0] && (
            <div className="relative aspect-[16/9] w-full bg-muted">
              <Image
                src={f.imageUrls[0]}
                alt={f.name}
                fill
                {...(index === 0 ? { priority: true } : { loading: 'lazy' as const })}
                sizes="(min-width: 768px) 50vw, 100vw"
                className="object-cover"
              />
            </div>
          )}
          <div className="p-6">
            <h2 className="text-xl font-semibold">{f.name}</h2>
            <FacilityMeta f={f} tenantName={data.tenantName} />
            <UnitTypeList f={f} locale={locale} />
            <Link
              href={
                f.publicSlug
                  ? `/s/${data.tenantSlug}/${f.publicSlug}`
                  : bookHref(data.tenantSlug, locale, { facilityId: f.id })
              }
              className="mt-4 inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-accent"
            >
              {f.publicSlug
                ? t('viewFacility', { name: f.name })
                : t('reserveAtFacility', { name: f.name })}
            </Link>
          </div>
        </section>
      ))}
    </div>
  );
}

// ============================================================================
// Secciones opcionales (Web Premium v2): testimonios · FAQ · contacto
// ============================================================================

function brandOf(data: PublicLandingDto): string {
  return data.brandColor ?? '#2563EB';
}

/** Banda con la promoción activa del tenant (si tiene alguna usable ahora mismo). */
export function PromoBanner({ data }: { data: PublicLandingDto }) {
  const t = useTranslations('publicWeb.promo');
  const promo = data.activePromotion;
  if (!promo) return null;
  const brand = brandOf(data);
  const discountText =
    promo.discountType === 'percentage'
      ? t('percentageOff', { value: promo.discountValue })
      : promo.discountType === 'fixed'
        ? t('fixedOff', { value: `${promo.discountValue} €` })
        : t('freeMonths', { count: promo.discountValue });
  return (
    <div
      className="mb-8 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border-2 border-dashed px-4 py-3 text-center text-sm"
      style={{ borderColor: brand, backgroundColor: `${brand}0d` }}
    >
      <span className="font-bold" style={{ color: brand }}>
        🎉 {discountText}
      </span>
      <span className="text-muted-foreground">
        {t('withCode')} <span className="font-mono font-bold text-foreground">{promo.code}</span>
      </span>
    </div>
  );
}

/**
 * Franja de confianza automática (nº de locales + ciudades), sin depender de
 * que el tenant rellene testimonios/FAQ. Da credibilidad instantánea a
 * tenants nuevos que aún no han escrito contenido propio.
 */
export function TrustBar({
  data,
  textClassName = 'text-muted-foreground',
}: {
  data: PublicLandingDto;
  /** Color del texto — la plantilla `industrial` (fondo oscuro fijo) pasa un tono claro propio. */
  textClassName?: string;
}) {
  const t = useTranslations('publicWeb.trust');
  if (data.facilities.length === 0) return null;
  const where = cities(data);
  return (
    <p className={`mb-6 text-center text-sm ${textClassName}`}>
      {t('facilitiesCount', { count: data.facilities.length })}
      {where ? ` ${t('inCities', { cities: where })}` : ''}
    </p>
  );
}

export function TestimonialsSection({ data }: TplProps) {
  const t = useTranslations('publicWeb.testimonials');
  if (data.testimonials.length === 0) return null;
  return (
    <section className="mt-14">
      <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">{t('title')}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.testimonials.map((testimonial, i) => (
          <figure key={i} className="rounded-lg border bg-card p-5 shadow-sm">
            <Quote className="h-5 w-5 opacity-40" style={{ color: brandOf(data) }} />
            <blockquote className="mt-2 text-sm leading-relaxed">{testimonial.comment}</blockquote>
            <figcaption className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{testimonial.author}</span>
              {testimonial.rating != null && (
                <span className="flex items-center gap-0.5">
                  {Array.from({ length: testimonial.rating }).map((_, s) => (
                    <Star
                      key={s}
                      className="h-3.5 w-3.5 fill-current"
                      style={{ color: '#f59e0b' }}
                    />
                  ))}
                </span>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/** Insignia de confianza: enlaza a las reseñas de Google del negocio, si el tenant la configuró. */
export function GoogleReviewBadge({ url }: { url: string }) {
  const t = useTranslations('publicWeb.common');
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <Star className="h-4 w-4 fill-current text-amber-500" />
      {t('googleReviews')}
    </a>
  );
}

export function FaqSection({ data }: TplProps) {
  const t = useTranslations('publicWeb.faq');
  // Sin FAQ propia del tenant -> preguntas genéricas por defecto (mismo
  // patrón ya usado en la plantilla `onepage`), para no dejar sin resolver
  // objeciones comunes solo porque el tenant no dedicó tiempo a configurarlas.
  const defaults = t.raw('defaults') as { question: string; answer: string }[];
  const faqs = data.faqs.length > 0 ? data.faqs : defaults;
  if (faqs.length === 0) return null;
  return (
    <section className="mt-14">
      <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">{t('title')}</h2>
      <div className="mx-auto max-w-2xl divide-y rounded-lg border bg-card">
        {faqs.map((faq, i) => (
          <details key={i} className="group px-5 py-4">
            <summary className="cursor-pointer list-none font-medium marker:content-none">
              {faq.question}
            </summary>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {faq.answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function ContactSection({ data }: TplProps) {
  const t = useTranslations('publicWeb.contact');
  if (!data.contactEnabled) return null;
  return (
    <section className="mt-14">
      <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">{t('title')}</h2>
      <p className="mb-6 text-center text-sm text-muted-foreground">{t('subtitle')}</p>
      <ContactForm slug={data.tenantSlug} brand={brandOf(data)} />
    </section>
  );
}

/**
 * Bloque con la calculadora de espacio (gratis, siempre visible) + las tres
 * secciones opcionales de Web Premium (testimonios · FAQ · contacto).
 */
export function ExtraSections({ data, locale }: TplProps) {
  return (
    <>
      <StorageCalculator data={data} brand={brandOf(data)} locale={locale} />
      <TestimonialsSection data={data} locale={locale} />
      {data.googleReviewUrl && (
        <div className="mt-4 flex justify-center">
          <GoogleReviewBadge url={data.googleReviewUrl} />
        </div>
      )}
      <FaqSection data={data} locale={locale} />
      <ContactSection data={data} locale={locale} />
    </>
  );
}
