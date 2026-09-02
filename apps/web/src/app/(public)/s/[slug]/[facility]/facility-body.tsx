'use client';

import { toEmbedVideoUrl } from '@storageos/shared';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { trackEvent } from '../google-analytics';
import { bookHref, type PublicWebLocale } from '../i18n/messages';
import { FacilityMeta, UnitTypeList } from '../templates';

import { buildFacilityJsonLd } from './facility-shared';

import type { PublicFacilityLandingDto } from '@storageos/shared';

import { safeJsonLd } from '@/lib/json-ld';

/** Vídeo del local: embebido si es un formato reconocido (YouTube/Vimeo), si no un enlace de respaldo. */
function FacilityVideo({ url, title }: { url: string; title: string }) {
  const embed = toEmbedVideoUrl(url);
  if (embed) {
    return (
      <iframe
        src={embed}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="mt-6 aspect-video w-full rounded-md border"
        title={title}
      />
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-6 inline-block text-sm text-primary underline"
    >
      {title}
    </a>
  );
}

function FacilityHeading({ f }: { f: PublicFacilityLandingDto['facility'] }) {
  const t = useTranslations('publicWeb.facility');
  return (
    <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
      {f.city
        ? t('headingWithCity', { city: f.city, name: f.name })
        : t('headingDefault', { name: f.name })}
    </h1>
  );
}

export function FacilityBody({
  data,
  slug,
  facilitySlug,
  locale,
}: {
  data: PublicFacilityLandingDto;
  slug: string;
  facilitySlug: string;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb');
  const f = data.facility;
  const jsonLd = buildFacilityJsonLd(data, slug, facilitySlug, locale);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />

      {data.logoUrl && (
        <Image
          src={data.logoUrl}
          alt={data.tenantName}
          width={170}
          height={48}
          className="mb-6 h-12 w-auto object-contain"
        />
      )}

      <nav className="mb-4 text-sm text-muted-foreground">
        <Link href={`/s/${data.tenantSlug}`} className="hover:text-foreground">
          {data.tenantName}
        </Link>
        <span className="mx-1.5">/</span>
        <span>{f.name}</span>
      </nav>

      <FacilityHeading f={f} />

      <FacilityMeta f={f} tenantName={data.tenantName} />

      {f.imageUrls.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {f.imageUrls.map((url, index) => (
            <div
              key={url}
              className="relative aspect-video w-full overflow-hidden rounded-md border"
            >
              <Image
                src={url}
                alt={t('facility.photoAlt', { index: index + 1, name: f.name })}
                fill
                {...(index === 0 ? { priority: true } : { loading: 'lazy' as const })}
                sizes="(min-width: 640px) 33vw, 50vw"
                className="object-cover"
              />
            </div>
          ))}
        </div>
      )}

      {f.videoUrl && <FacilityVideo url={f.videoUrl} title={t('facility.video')} />}

      <Link
        href={bookHref(data.tenantSlug, locale, { facilityId: f.id })}
        onClick={() => trackEvent('cta_reservar_click', { location: 'facility_page' })}
        className="mt-6 inline-flex h-11 items-center rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
        style={{ backgroundColor: data.brandColor ?? 'hsl(var(--primary))' }}
      >
        {t('common.reserveNow')}
      </Link>

      <h2 className="mt-10 text-xl font-semibold">{t('facility.sizesAndPrices')}</h2>
      <UnitTypeList f={f} locale={locale} />
    </div>
  );
}
