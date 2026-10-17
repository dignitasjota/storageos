'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { trackEvent } from '../google-analytics';
import {
  bookHrefFor,
  cityPageHref,
  facilityHref,
  landingHref,
  type PublicWebLocale,
} from '../i18n/messages';
import { FacilityMeta, UnitTypeList } from '../templates';

import type { CityPage, PublicLandingDto } from '@storageos/shared';

type Facility = PublicLandingDto['facilities'][number];

/** Página de una ciudad: sus centros con tamaños y precios, y preguntas de la ciudad. */
export function CityBody({
  data,
  page,
  others,
  fromPrice,
  locale,
}: {
  data: PublicLandingDto;
  page: CityPage<Facility>;
  others: { name: string; slug: string }[];
  fromPrice: string | null;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb');
  const brand = data.brandColor ?? '#2563EB';
  const addresses = page.facilities
    .map((f) => [f.name, f.address].filter(Boolean).join(', '))
    .join('; ');
  const faqs = [
    {
      q: t('city.q1', { city: page.name }),
      a: fromPrice
        ? t('city.a1', { city: page.name, tenantName: data.tenantName, price: fromPrice })
        : t('city.a1NoPrice'),
    },
    {
      q: t('city.q2', { city: page.name, tenantName: data.tenantName }),
      a: t('city.a2', { city: page.name, count: page.facilities.length, addresses }),
    },
    { q: t('city.q3'), a: t('city.a3') },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <nav className="mb-4 text-sm text-muted-foreground">
        <Link
          href={landingHref(data.tenantSlug, locale, data.customDomain)}
          className="hover:text-foreground"
        >
          {data.tenantName}
        </Link>
        <span className="mx-1.5">/</span>
        <span>{t('city.heading', { city: page.name })}</span>
      </nav>
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
        {t('city.heading', { city: page.name })}
      </h1>
      <p className="mt-3 text-lg text-muted-foreground">
        {t('city.intro', {
          count: page.facilities.length,
          tenantName: data.tenantName,
          city: page.name,
        })}{' '}
        {fromPrice && t('city.fromPrice', { price: fromPrice })}
      </p>
      <Link
        href={bookHrefFor(data, locale)}
        onClick={() => trackEvent('cta_reservar_click', { location: 'city_page' })}
        className="mt-6 inline-flex h-11 items-center rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
        style={{ backgroundColor: brand }}
      >
        {t('common.reserveNow')}
      </Link>

      <div className="mt-10 space-y-6">
        {page.facilities.map((f) => (
          <section key={f.id} className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold">
              {f.publicSlug ? (
                <Link
                  href={facilityHref(data.tenantSlug, f.publicSlug, locale, data.customDomain)}
                  className="hover:underline"
                >
                  {f.name}
                </Link>
              ) : (
                f.name
              )}
            </h2>
            <FacilityMeta f={f} tenantName={data.tenantName} />
            <UnitTypeList f={f} locale={locale} site={data} />
          </section>
        ))}
      </div>

      <section className="mt-14">
        <h2 className="mb-6 text-2xl font-bold tracking-tight">
          {t('city.faqTitle', { city: page.name })}
        </h2>
        <div className="divide-y rounded-lg border bg-card">
          {faqs.map((f) => (
            <details key={f.q} className="px-5 py-4" open>
              <summary className="cursor-pointer list-none font-medium marker:content-none">
                {f.q}
              </summary>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {others.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-3 text-lg font-semibold">{t('city.otherCities')}</h2>
          <ul className="flex flex-wrap gap-2">
            {others.map((c) => (
              <li key={c.slug}>
                <Link
                  href={cityPageHref(data.tenantSlug, c.slug, locale, data.customDomain)}
                  className="inline-flex h-9 items-center rounded-full border px-4 text-sm hover:bg-accent"
                >
                  {t('city.heading', { city: c.name })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
