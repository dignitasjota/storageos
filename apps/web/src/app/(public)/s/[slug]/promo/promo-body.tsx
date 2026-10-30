'use client';

import {
  FIRST_PAYMENT_MONTHS,
  promoCampaign,
  promoSectionOrder,
  type PromoCtaAction,
  type PromoSectionKey,
  type PublicPromoPageDto,
} from '@storageos/shared';
import { Check, Clock, MapPin, Warehouse } from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { bookHrefFor, type PublicWebLocale } from '../i18n/messages';
import { grossPrice, formatPrice } from '../price-format';

import { PromoLeadForm } from './promo-lead-form';
import { bandColor, softAccent, themeFor, type PromoTheme } from './promo-theme';

import { currentTrafficSource, visitorId } from '@/lib/attribution';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Variables de seguimiento de la visita: las del enlace (flyer, QR, anuncio…),
 * la web de la que viene o el origen con el que entró antes en la web; si no se
 * sabe, «web». La campaña es la de la landing si el enlace no trae otra. En la
 * vista previa no se cuenta la visita.
 */
function useTracking(tenantSlug: string, slug: string, preview: boolean): Record<string, string> {
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
    if (preview) return;
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
  }, [tenantSlug, slug, preview]);
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

/** Cabecera común de los bloques: antetítulo, título y texto. */
function SectionHead({
  eyebrow,
  title,
  description,
  theme,
  center = true,
  light = false,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  theme: PromoTheme;
  center?: boolean;
  light?: boolean;
}) {
  const upper = theme.upper ? 'uppercase tracking-wide' : '';
  if (!eyebrow && !title && !description) return null;
  return (
    <div className={`mb-8 max-w-2xl ${center ? 'mx-auto text-center' : ''}`}>
      {eyebrow && (
        <p
          className="mb-2 text-xs font-bold uppercase tracking-[0.14em]"
          style={{ color: light ? '#ffffff' : theme.accent }}
        >
          {eyebrow}
        </p>
      )}
      {title && <h2 className={`text-2xl font-extrabold sm:text-3xl ${upper}`}>{title}</h2>}
      {description && (
        <p
          className={`mt-3 ${light ? 'text-white/80' : theme.dark ? 'text-neutral-400' : 'text-slate-600'}`}
        >
          {description}
        </p>
      )}
    </div>
  );
}

export function PromoBody({ data, locale }: { data: PublicPromoPageDto; locale: PublicWebLocale }) {
  const t = useTranslations('publicWeb.promoLanding');
  const { site, promo } = data;
  const c = promo.content;
  const theme = themeFor(site.webTemplate, site.brandColor);
  const upper = theme.upper ? 'uppercase tracking-wide' : '';
  const surface = theme.dark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-slate-200';
  const muted = theme.dark ? 'text-neutral-400' : 'text-slate-600';
  const altBg = theme.dark ? 'bg-neutral-900/60' : 'bg-white';
  const coupon = promo.coupon;
  const months = coupon ? monthsFor(coupon.minMonths) : undefined;
  const utm = useTracking(site.tenantSlug, promo.slug, promo.preview);
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
  const sizesForForm = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of facilities) for (const ut of f.unitTypes) seen.set(ut.id, ut.name);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [facilities]);
  const onlyFacility = facilities.length === 1 ? facilities[0] : undefined;
  const mainHref = bookHrefFor(site, locale, bookParams(onlyFacility?.id));
  const heroImage = promo.heroImageUrl ?? onlyFacility?.imageUrls[0] ?? null;
  const phone = (onlyFacility ?? facilities[0])?.contactPhone ?? null;

  const order = promoSectionOrder(c.order);
  const visible: Record<PromoSectionKey, boolean> = {
    benefits: c.benefits.enabled && c.benefits.items.length > 0,
    sizes: c.sizes.enabled && facilities.length > 0,
    steps: c.steps.enabled && c.steps.items.length > 0,
    promotion: c.promotion.enabled && !!(c.promotion.panelTitle || c.promotion.panelText),
    conditions: c.conditions.enabled && (c.conditions.items.length > 0 || !!c.conditions.closing),
    testimonials: c.testimonials.enabled && site.testimonials.length > 0,
    faq:
      c.faq.enabled &&
      (c.faq.items.length > 0 || (c.faq.useBusinessFaq && site.faqEnabled && site.faqs.length > 0)),
    contact: c.contact.enabled,
  };
  const faqs =
    c.faq.items.length > 0 ? c.faq.items : c.faq.useBusinessFaq && site.faqEnabled ? site.faqs : [];

  /** Destino de un botón según su acción; null si no se puede (sin teléfono, sin WhatsApp…). */
  function ctaHref(action: PromoCtaAction): string | null {
    switch (action) {
      case 'book':
        return mainHref;
      case 'sizes':
        return visible.sizes ? '#tamanos' : mainHref;
      case 'form':
        return visible.contact ? '#contacto' : mainHref;
      case 'call':
        return phone ? `tel:${phone.replace(/\s+/g, '')}` : null;
      case 'whatsapp':
        return site.whatsappNumber
          ? `https://wa.me/${site.whatsappNumber}?text=${encodeURIComponent(
              `Hola, vengo de vuestra promoción «${promo.headline}».`,
            )}`
          : null;
    }
  }
  const btn = `inline-flex items-center justify-center px-6 py-3 text-base font-semibold transition hover:opacity-90 ${theme.button} ${upper}`;
  const Cta = ({
    cta,
    variant = 'solid',
    onDark = false,
  }: {
    cta: { label: string; action: PromoCtaAction } | null;
    variant?: 'solid' | 'outline';
    onDark?: boolean;
  }) => {
    if (!cta) return null;
    const href = ctaHref(cta.action);
    if (!href) return null;
    const external = href.startsWith('https://wa.me');
    const style =
      variant === 'solid'
        ? onDark
          ? { backgroundColor: '#ffffff', color: theme.accent }
          : { backgroundColor: theme.accent, color: '#ffffff' }
        : {
            borderColor: onDark ? '#ffffff' : theme.accent,
            color: onDark ? '#ffffff' : theme.accent,
          };
    return (
      <a
        href={href}
        className={`${btn} ${variant === 'outline' ? 'border-2' : 'shadow-sm'}`}
        style={style}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {cta.label}
      </a>
    );
  };
  const conditionsLink = (label: string, light = false) =>
    visible.conditions && label ? (
      <a
        href="#condiciones"
        className={`text-sm font-semibold underline underline-offset-4 ${light ? 'text-white' : ''}`}
        style={light ? undefined : { color: theme.accent }}
      >
        {label}
      </a>
    ) : null;

  const sections: Record<PromoSectionKey, () => React.ReactNode> = {
    benefits: () => (
      <section id="ventajas" className="px-4 py-14">
        <div className="mx-auto max-w-6xl">
          <SectionHead {...c.benefits} theme={theme} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {c.benefits.items.map((b) => (
              <div key={b.title} className={`border p-6 ${theme.radius} ${surface}`}>
                <span
                  className={`mb-4 inline-flex h-11 w-11 items-center justify-center text-xl ${theme.button}`}
                  style={{ backgroundColor: softAccent(theme), color: theme.accent }}
                  aria-hidden
                >
                  {b.icon || <Check className="h-5 w-5" />}
                </span>
                <h3 className={`text-lg font-bold ${upper}`}>{b.title}</h3>
                {b.description && <p className={`mt-2 text-sm ${muted}`}>{b.description}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>
    ),
    sizes: () => (
      <section id="tamanos" className={`px-4 py-14 ${altBg}`}>
        <div className="mx-auto max-w-6xl">
          <SectionHead {...c.sizes} theme={theme} />
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
                    const text = c.sizes.descriptions[ut.id];
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
                        {text && <p className={`mt-2 text-sm ${muted}`}>{text}</p>}
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
                          className={`mt-4 ${btn} py-2 text-sm text-white`}
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
        </div>
      </section>
    ),
    steps: () => (
      <section id="pasos" className="px-4 py-14">
        <div className="mx-auto max-w-6xl">
          <SectionHead eyebrow={c.steps.eyebrow} title={c.steps.title} theme={theme} />
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {c.steps.items.map((s, i) => (
              <li key={s.title} className={`border p-6 ${theme.radius} ${surface}`}>
                <span
                  className={`mb-4 inline-flex h-10 w-10 items-center justify-center font-extrabold text-white ${theme.button}`}
                  style={{ backgroundColor: theme.accent }}
                >
                  {i + 1}
                </span>
                <h3 className={`text-lg font-bold ${upper}`}>{s.title}</h3>
                {s.description && <p className={`mt-2 text-sm ${muted}`}>{s.description}</p>}
              </li>
            ))}
          </ol>
        </div>
      </section>
    ),
    promotion: () => (
      <section
        id="promocion"
        className="px-4 py-16 text-white"
        style={{ backgroundColor: bandColor(theme) }}
      >
        <div className="mx-auto max-w-6xl">
          <SectionHead {...c.promotion} theme={theme} light />
          <div
            className={`grid items-center gap-6 border border-white/15 bg-white/5 p-6 sm:p-8 md:grid-cols-[1fr_auto] ${theme.radius}`}
          >
            <div>
              {c.promotion.panelTitle && (
                <h3 className={`text-xl font-bold sm:text-2xl ${upper}`}>
                  {c.promotion.panelTitle}
                </h3>
              )}
              {c.promotion.panelText && (
                <p className="mt-3 whitespace-pre-line text-white/85">{c.promotion.panelText}</p>
              )}
              {coupon && (
                <p className="mt-3 text-sm text-white/85">
                  {t('couponIncluded', { code: coupon.code, summary: coupon.summary })}
                </p>
              )}
              {c.promotion.terms && (
                <p className="mt-3 text-xs text-white/60">{c.promotion.terms}</p>
              )}
              <div className="mt-3">{conditionsLink(c.promotion.conditionsLink, true)}</div>
            </div>
            <div>
              <Cta cta={c.promotion.cta} onDark />
            </div>
          </div>
        </div>
      </section>
    ),
    conditions: () => (
      <section id="condiciones" className="px-4 py-14">
        <div className={`mx-auto max-w-3xl border p-6 sm:p-8 ${theme.radius} ${surface}`}>
          <SectionHead {...c.conditions} theme={theme} center={false} />
          {c.conditions.items.length > 0 && (
            <ul className="space-y-2">
              {c.conditions.items.map((item) => (
                <li key={item} className="flex gap-3 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: theme.accent }} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )}
          {c.conditions.closing && (
            <p className={`mt-4 whitespace-pre-line text-sm ${muted}`}>{c.conditions.closing}</p>
          )}
          {c.conditions.cta && (
            <div className="mt-6">
              <Cta cta={c.conditions.cta} />
            </div>
          )}
        </div>
      </section>
    ),
    testimonials: () => (
      <section id="opiniones" className={`px-4 py-14 ${altBg}`}>
        <div className="mx-auto max-w-6xl">
          <SectionHead eyebrow="" title={c.testimonials.title} theme={theme} />
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
        </div>
      </section>
    ),
    faq: () => (
      <section id="preguntas" className="px-4 py-14">
        <div className="mx-auto max-w-3xl">
          <SectionHead {...c.faq} theme={theme} />
          <div className="space-y-3">
            {faqs.map((faq) => (
              <details key={faq.question} className={`border p-4 ${theme.radius} ${surface}`}>
                <summary className="cursor-pointer font-semibold">{faq.question}</summary>
                <p className={`mt-2 whitespace-pre-line text-sm ${muted}`}>{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    ),
    contact: () => (
      <section id="contacto" className={`px-4 py-14 ${altBg}`}>
        <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-2 md:items-start">
          <div>
            <SectionHead {...c.contact} theme={theme} center={false} />
            {c.contact.trust.length > 0 && (
              <ul className="space-y-2">
                {c.contact.trust.map((item) => (
                  <li key={item} className="flex gap-3">
                    <Check className="mt-0.5 h-5 w-5 shrink-0" style={{ color: theme.accent }} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={`border p-6 shadow-sm ${theme.radius} ${surface}`}>
            <PromoLeadForm
              tenantSlug={site.tenantSlug}
              promoSlug={promo.slug}
              customDomain={site.customDomain}
              sizes={sizesForForm}
              utm={utm}
              theme={theme}
              buttonLabel={c.contact.buttonLabel || t('form.submit')}
              legal={c.contact.legal}
              successMessage={c.contact.successMessage || t('form.sent')}
              disabled={promo.preview}
            />
          </div>
        </div>
      </section>
    ),
  };

  const offerCard = c.offer.enabled && c.offer.title;
  const highlight = c.offer.enabled ? c.offer.highlight : '';

  return (
    <div className={theme.dark ? 'bg-neutral-950 text-neutral-100' : 'bg-slate-50 text-slate-900'}>
      {promo.preview && (
        <p className="bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-black">
          {t('previewBanner')}
        </p>
      )}
      {c.topbar.enabled && c.topbar.text && (
        <p
          className="px-4 py-2 text-center text-sm font-semibold text-white"
          style={{ backgroundColor: theme.accent }}
        >
          {c.topbar.text}
        </p>
      )}

      {/* Portada */}
      <section className="px-4 py-12 sm:py-16">
        <div className="mx-auto grid max-w-6xl items-center gap-10 md:grid-cols-2">
          <div>
            {c.hero.eyebrow && (
              <p
                className="mb-3 text-xs font-bold uppercase tracking-[0.14em]"
                style={{ color: theme.accent }}
              >
                {c.hero.eyebrow}
              </p>
            )}
            <h1 className={`text-3xl font-extrabold leading-tight sm:text-5xl ${upper}`}>
              {promo.headline}
            </h1>
            {promo.subheadline && (
              <p className={`mt-4 whitespace-pre-line text-lg ${muted}`}>{promo.subheadline}</p>
            )}
            <div className="mt-7 flex flex-wrap gap-3">
              <Cta cta={c.hero.primaryCta} />
              <Cta cta={c.hero.secondaryCta} variant="outline" />
            </div>
            {highlight && (
              <p
                className={`mt-6 inline-block px-4 py-2 text-sm font-bold ${theme.button}`}
                style={{ backgroundColor: softAccent(theme), color: theme.accent }}
              >
                {highlight}
              </p>
            )}
            {c.offer.enabled && (
              <div className="mt-3">{conditionsLink(c.offer.conditionsLink)}</div>
            )}
            {promo.showCountdown && promo.endsAt && (
              <Countdown endsAt={promo.endsAt} className={`mt-4 text-sm ${muted}`} />
            )}
            {c.hero.trustItems.length > 0 && (
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
                {c.hero.trustItems.map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <Check className="h-4 w-4" style={{ color: theme.accent }} aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="relative">
            <div
              className={`relative aspect-[4/3] overflow-hidden ${theme.radius}`}
              style={heroImage ? undefined : { backgroundColor: softAccent(theme, 0.18) }}
            >
              {!heroImage && (
                <Warehouse
                  className="absolute inset-0 m-auto h-24 w-24 opacity-40"
                  style={{ color: theme.accent }}
                  aria-hidden
                />
              )}
              {heroImage && (
                <Image
                  src={heroImage}
                  alt={c.hero.imageAlt}
                  fill
                  priority
                  className="object-cover"
                  sizes="(min-width: 768px) 50vw, 100vw"
                />
              )}
            </div>
            {offerCard && (
              <div
                className={`absolute -bottom-5 left-4 max-w-[75%] p-4 text-white shadow-lg sm:left-6 ${theme.radius}`}
                style={{ backgroundColor: theme.accent }}
              >
                {c.offer.eyebrow && (
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-white/80">
                    {c.offer.eyebrow}
                  </p>
                )}
                <p className={`text-2xl font-extrabold leading-tight ${upper}`}>{c.offer.title}</p>
                {c.offer.subtitle && (
                  <p className="mt-1 text-sm text-white/85">{c.offer.subtitle}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {order
        .filter((k) => visible[k])
        .map((k) => (
          <div key={k}>{sections[k]()}</div>
        ))}
    </div>
  );
}
