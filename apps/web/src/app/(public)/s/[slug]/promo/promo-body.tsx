'use client';

import { FIRST_PAYMENT_MONTHS, promoCampaign, type PublicPromoPageDto } from '@storageos/shared';
import { Check, Clock, MapPin } from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { ContactForm } from '../contact-form';
import { bookHrefFor, type PublicWebLocale } from '../i18n/messages';
import { grossPrice, formatPrice } from '../price-format';

import { themeFor } from './promo-theme';

import { currentTrafficSource, visitorId } from '@/lib/attribution';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Variables de seguimiento de la visita: las del enlace (flyer, QR, anuncio…),
 * la web de la que viene o el origen con el que entró antes en la web; si no se
 * sabe, «web». La campaña es la de la landing si el enlace no trae otra.
 */
function useTracking(tenantSlug: string, slug: string): Record<string, string> {
  const [utm, setUtm] = useState<Record<string, string>>({});
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const origin = currentTrafficSource(tenantSlug);
    const next = {
      utm_source: origin?.source || 'web',
      utm_medium: origin?.medium || 'landing',
      utm_campaign: sp.get('utm_campaign') || promoCampaign(slug),
    };
    setUtm(next);
    // Visita (para saber de dónde vienen). Best-effort: nunca rompe la página.
    void fetch(
      `${API_URL}/public/landing/${encodeURIComponent(tenantSlug)}/promo/${encodeURIComponent(slug)}/visit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitorId: visitorId(),
          source: next.utm_source,
          medium: next.utm_medium,
          campaign: next.utm_campaign,
        }),
        keepalive: true,
      },
    ).catch(() => undefined);
  }, [tenantSlug, slug]);
  return utm;
}

/** Meses del primer pago que cumplen el mínimo del cupón (1, 3, 6 o 12). */
function monthsFor(minMonths: number): number {
  return FIRST_PAYMENT_MONTHS.find((m) => m >= minMonths) ?? 12;
}

function Countdown({ endsAt, className }: { endsAt: string; className: string }) {
  const t = useTranslations('publicWeb.promoLanding');
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return null;
  const left = new Date(endsAt).getTime() - now;
  if (left <= 0) return <p className={className}>{t('ended')}</p>;
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  return (
    <p className={`inline-flex items-center gap-2 ${className}`}>
      <Clock className="h-4 w-4" aria-hidden />
      {t('endsIn')}{' '}
      <strong>
        {days > 0 && `${t('days', { count: days })} `}
        {t('hours', { count: hours })} {t('minutes', { count: minutes })}
      </strong>
    </p>
  );
}

export function PromoBody({ data, locale }: { data: PublicPromoPageDto; locale: PublicWebLocale }) {
  const t = useTranslations('publicWeb.promoLanding');
  const { site, promo } = data;
  const theme = themeFor(site.webTemplate, site.brandColor);
  const upper = theme.upper ? 'uppercase tracking-wide' : '';
  const surface = theme.dark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-slate-200';
  const muted = theme.dark ? 'text-neutral-400' : 'text-slate-600';
  const coupon = promo.coupon;
  const months = coupon ? monthsFor(coupon.minMonths) : undefined;
  const utm = useTracking(site.tenantSlug, promo.slug);
  const bookParams = (facilityId?: string, unitTypeId?: string) => ({
    utm,
    ...(facilityId ? { facilityId } : {}),
    ...(unitTypeId ? { unitTypeId } : {}),
    ...(coupon ? { coupon: coupon.code } : {}),
    ...(months ? { months } : {}),
  });

  // Locales y tamaños de la promoción (vacío = todos).
  const facilities = useMemo(
    () =>
      site.facilities
        .filter((f) => promo.facilityIds.length === 0 || promo.facilityIds.includes(f.id))
        .map((f) => ({
          ...f,
          unitTypes: f.unitTypes.filter(
            (ut) => promo.unitTypeIds.length === 0 || promo.unitTypeIds.includes(ut.id),
          ),
        }))
        .filter((f) => f.unitTypes.length > 0),
    [site.facilities, promo.facilityIds, promo.unitTypeIds],
  );
  const onlyFacility = facilities.length === 1 ? facilities[0] : undefined;
  const mainHref = bookHrefFor(site, locale, bookParams(onlyFacility?.id));
  const heroImage = promo.heroImageUrl ?? onlyFacility?.imageUrls[0] ?? null;
  const cta = promo.ctaLabel ?? t('reserve');
  const btn = `inline-flex items-center justify-center px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:opacity-90 ${theme.button} ${upper}`;

  return (
    <div className={theme.dark ? 'bg-neutral-950 text-neutral-100' : 'bg-slate-50 text-slate-900'}>
      {/* Portada */}
      <section className="relative overflow-hidden">
        {heroImage ? (
          <>
            <Image src={heroImage} alt="" fill priority className="object-cover" sizes="100vw" />
            <div className="absolute inset-0 bg-black/55" aria-hidden />
          </>
        ) : (
          <div className="absolute inset-0" style={{ backgroundColor: theme.accent }} aria-hidden />
        )}
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center text-white sm:py-28">
          {promo.offerText && (
            <span
              className={`mb-5 inline-block bg-white px-4 py-1.5 text-sm font-bold ${theme.button} ${upper}`}
              style={{ color: theme.accent }}
            >
              {promo.offerText}
            </span>
          )}
          <h1 className={`text-3xl font-extrabold leading-tight sm:text-5xl ${upper}`}>
            {promo.headline}
          </h1>
          {promo.subheadline && (
            <p className="mx-auto mt-4 max-w-2xl text-lg text-white/90">{promo.subheadline}</p>
          )}
          <div className="mt-8 flex flex-col items-center gap-4">
            {/* Sin foto el fondo es el color de marca: el botón va en blanco. */}
            <a
              href={mainHref}
              className={btn}
              style={
                heroImage
                  ? { backgroundColor: theme.accent }
                  : { backgroundColor: '#ffffff', color: theme.accent }
              }
            >
              {cta}
            </a>
            {promo.showCountdown && promo.endsAt && (
              <Countdown endsAt={promo.endsAt} className="text-sm text-white/90" />
            )}
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl space-y-14 px-4 py-14">
        {coupon && (
          <p
            className={`border px-4 py-3 text-center text-sm ${theme.radius} ${surface}`}
            style={{ borderColor: theme.accent }}
          >
            {t('couponIncluded', { code: coupon.code, summary: coupon.summary })}
          </p>
        )}

        {(promo.benefits.length > 0 || promo.body) && (
          <section className="grid gap-8 md:grid-cols-2">
            {promo.benefits.length > 0 && (
              <div>
                <h2 className={`mb-4 text-2xl font-bold ${upper}`}>{t('benefitsTitle')}</h2>
                <ul className="space-y-3">
                  {promo.benefits.map((b) => (
                    <li key={b} className="flex gap-3">
                      <Check className="mt-0.5 h-5 w-5 shrink-0" style={{ color: theme.accent }} />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {promo.body && <p className={`whitespace-pre-line ${muted}`}>{promo.body}</p>}
          </section>
        )}

        {facilities.length > 0 && (
          <section id="precios">
            <h2 className={`mb-6 text-2xl font-bold ${upper}`}>{t('sizesTitle')}</h2>
            <div className="space-y-8">
              {facilities.map((f) => (
                <div key={f.id}>
                  {facilities.length > 1 && (
                    <p className={`mb-3 flex items-center gap-2 font-semibold ${muted}`}>
                      <MapPin className="h-4 w-4" /> {f.name}
                      {f.city ? ` · ${f.city}` : ''}
                    </p>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {f.unitTypes.map((ut) => {
                      const soldOut = ut.available === 0;
                      const href = bookHrefFor(site, locale, {
                        ...bookParams(f.id, ut.id),
                        ...(soldOut ? { waitlist: true } : {}),
                      });
                      return (
                        <div
                          key={ut.id}
                          className={`flex flex-col border p-5 ${theme.radius} ${surface}`}
                        >
                          <p className={`text-lg font-bold ${upper}`}>{ut.name}</p>
                          {ut.areaM2 !== null && (
                            <p className={`text-sm ${muted}`}>
                              {t('m2', { value: ut.areaM2.toLocaleString('es-ES') })}
                            </p>
                          )}
                          <p className="mt-3 text-2xl font-extrabold">
                            <span className={`text-sm font-normal ${muted}`}>{t('from')} </span>
                            {formatPrice(grossPrice(ut), locale)}
                            <span className={`text-sm font-normal ${muted}`}>{t('perMonth')}</span>
                          </p>
                          <p className={`text-xs ${muted}`}>{t('vatIncluded')}</p>
                          <p
                            className={`mt-2 text-sm font-medium ${soldOut ? muted : ''}`}
                            style={
                              !soldOut && ut.available <= 2 ? { color: theme.accent } : undefined
                            }
                          >
                            {soldOut
                              ? t('soldOut')
                              : ut.available <= 2
                                ? t('lastUnits', { count: ut.available })
                                : t('available')}
                          </p>
                          <a
                            href={href}
                            className={`mt-4 ${btn} py-2 text-sm`}
                            style={{ backgroundColor: soldOut ? '#64748b' : theme.accent }}
                          >
                            {soldOut ? t('notify') : t('reserveThis')}
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {promo.conditions && (
          <section className={`border p-6 ${theme.radius} ${surface}`}>
            <h2 className={`mb-3 text-lg font-bold ${upper}`}>{t('conditionsTitle')}</h2>
            <p className={`whitespace-pre-line text-sm ${muted}`}>{promo.conditions}</p>
          </section>
        )}

        {promo.showTestimonials && site.testimonials.length > 0 && (
          <section>
            <h2 className={`mb-6 text-2xl font-bold ${upper}`}>{t('reviewsTitle')}</h2>
            <div className="grid gap-4 md:grid-cols-3">
              {site.testimonials.slice(0, 3).map((r) => (
                <figure
                  key={`${r.author}-${r.comment}`}
                  className={`border p-5 ${theme.radius} ${surface}`}
                >
                  <blockquote className="text-sm">“{r.comment}”</blockquote>
                  <figcaption className={`mt-3 text-sm font-semibold ${muted}`}>
                    {r.author}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {promo.showFaq && site.faqs.length > 0 && (
          <section>
            <h2 className={`mb-6 text-2xl font-bold ${upper}`}>{t('faqTitle')}</h2>
            <div className="space-y-3">
              {site.faqs.map((faq) => (
                <details key={faq.question} className={`border p-4 ${theme.radius} ${surface}`}>
                  <summary className="cursor-pointer font-semibold">{faq.question}</summary>
                  <p className={`mt-2 whitespace-pre-line text-sm ${muted}`}>{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        {promo.showContact && site.contactEnabled && (
          <section id="contacto" className={`border p-6 ${theme.radius} ${surface}`}>
            <h2 className={`mb-4 text-2xl font-bold ${upper}`}>{t('contactTitle')}</h2>
            <ContactForm
              slug={site.tenantSlug}
              customDomain={site.customDomain}
              brand={theme.accent}
            />
          </section>
        )}

        <div className="text-center">
          <a href={mainHref} className={btn} style={{ backgroundColor: theme.accent }}>
            {cta}
          </a>
        </div>
      </div>
    </div>
  );
}
