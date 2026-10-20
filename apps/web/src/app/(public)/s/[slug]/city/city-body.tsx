'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { AreaFaqs, AreaIntro } from '../area-content';
import { trackEvent } from '../google-analytics';
import {
  bookHrefFor,
  cityPageHref,
  facilityHref,
  landingHref,
  type PublicWebLocale,
} from '../i18n/messages';
import { FacilityMeta, UnitTypeList } from '../templates';

import type {
  AreaPageFaq,
  AreaPageKind,
  PublicLandingDto,
  ResolvedAreaPage,
} from '@storageos/shared';

type Facility = PublicLandingDto['facilities'][number];

/** Página de zona: ciudad con sus centros o zona cercana con el centro más cercano. */
export function CityBody({
  data,
  page,
  faqs,
  others,
  fromPrice,
  locale,
}: {
  data: PublicLandingDto;
  page: ResolvedAreaPage<Facility>;
  faqs: AreaPageFaq[];
  others: { name: string; slug: string; kind: AreaPageKind }[];
  fromPrice: string | null;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb');
  const brand = data.brandColor ?? '#2563EB';
  const near = page.kind === 'nearby';
  const heading = near
    ? t('area.nearHeading', { city: page.name })
    : t('city.heading', { city: page.name });

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
        <span>{heading}</span>
      </nav>
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{heading}</h1>
      <p className="mt-3 text-lg text-muted-foreground">
        {near
          ? page.content?.nearestNote ||
            t('area.nearIntro', {
              city: page.name,
              names: page.facilities.map((f) => f.name).join(', '),
            })
          : t('city.intro', {
              count: page.facilities.length,
              tenantName: data.tenantName,
              city: page.name,
            })}{' '}
        {fromPrice && t('city.fromPrice', { price: fromPrice })}
      </p>
      <AreaIntro content={page.content} />
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

      <AreaFaqs title={t('city.faqTitle', { city: page.name })} faqs={faqs} />

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
                  {c.kind === 'nearby'
                    ? t('area.nearHeading', { city: c.name })
                    : t('city.heading', { city: c.name })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
