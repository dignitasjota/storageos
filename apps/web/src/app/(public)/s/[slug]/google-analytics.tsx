'use client';

import Link from 'next/link';
import Script from 'next/script';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { facilityHref, legalHref } from './i18n/messages';

import type { AreaPageLinkDto } from '@storageos/shared';

/**
 * Envía un evento de conversión a GA4 (`gtag('event', ...)`). No-op si el
 * tenant no configuró GA4 o el visitante no aceptó la analítica (sin
 * `window.gtag`) — llamar sin comprobar antes es siempre seguro.
 */
export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { gtag?: (...args: unknown[]) => void };
  w.gtag?.('event', name, params ?? {});
}

/** Lo mínimo de la web del tenant para el aviso de cookies y los enlaces legales. */
export interface TenantSiteRef {
  tenantSlug: string;
  customDomain?: string | null;
  /** Páginas de zona («trasteros en …») que se enlazan en el pie. */
  areaLinks?: AreaPageLinkDto[];
}

type Consent = 'all' | 'necessary';
const CONSENT_EVENT = 'storageos:tenant-cookie-consent';

function consentKey(slug: string): string {
  return `storageos.tenant-cookies.${slug}`;
}

function readConsent(slug: string): Consent | null {
  try {
    const v = window.localStorage.getItem(consentKey(slug));
    return v === 'all' || v === 'necessary' ? v : null;
  } catch {
    return null;
  }
}

function writeConsent(slug: string, value: Consent | null): void {
  try {
    if (value) window.localStorage.setItem(consentKey(slug), value);
    else window.localStorage.removeItem(consentKey(slug));
  } catch {
    // Sin almacenamiento (modo privado): se vuelve a preguntar en la próxima visita.
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: value }));
}

/**
 * Google Analytics 4 de la web del tenant (si lo configuró en Ajustes → Marca y
 * SEO), **solo con el consentimiento del visitante**: hasta que elige, se
 * muestra el aviso de cookies y no se carga nada de Google (LSSI art. 22.2).
 * Sin GA4 configurado no hay cookies que no sean necesarias: ni aviso ni script.
 */
export function GoogleAnalyticsScript({
  measurementId,
  site,
}: {
  measurementId: string | null;
  site: TenantSiteRef;
}) {
  const t = useTranslations('publicWeb.legal');
  const [consent, setConsent] = useState<Consent | null | undefined>(undefined);

  useEffect(() => {
    setConsent(readConsent(site.tenantSlug));
    const onChange = (e: Event) => setConsent((e as CustomEvent<Consent | null>).detail);
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, [site.tenantSlug]);

  if (!measurementId || consent === undefined) return null;
  if (consent === 'all') {
    return (
      <>
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
          strategy="afterInteractive"
        />
        <Script id="ga4-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${measurementId}');`}
        </Script>
      </>
    );
  }
  if (consent === 'necessary') return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-xl border bg-background/95 p-4 text-foreground shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {t('bannerText')}{' '}
          <Link
            href={legalHref(site.tenantSlug, 'cookies', site.customDomain)}
            className="font-medium text-foreground underline"
          >
            {t('cookies')}
          </Link>
          .
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => writeConsent(site.tenantSlug, 'necessary')}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-accent"
          >
            {t('necessaryOnly')}
          </button>
          <button
            type="button"
            onClick={() => writeConsent(site.tenantSlug, 'all')}
            className="h-9 rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90"
          >
            {t('acceptAll')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Enlaces legales del pie de la web del tenant (aviso legal, privacidad,
 * cookies, condiciones de contratación y, con analítica, «Configurar cookies»). Hereda el color del pie.
 */
export function TenantLegalLinks({
  site,
  analytics,
  className = '',
}: {
  site: TenantSiteRef;
  analytics: boolean;
  className?: string;
}) {
  const t = useTranslations('publicWeb.legal');
  const tWeb = useTranslations('publicWeb');
  const locale = useLocale().startsWith('en') ? 'en' : 'es';
  const link = 'transition hover:underline';
  const legal = (
    <nav
      aria-label={t('navLabel')}
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`}
    >
      <Link href={legalHref(site.tenantSlug, 'aviso-legal', site.customDomain)} className={link}>
        {t('notice')}
      </Link>
      <Link href={legalHref(site.tenantSlug, 'privacidad', site.customDomain)} className={link}>
        {t('privacy')}
      </Link>
      <Link href={legalHref(site.tenantSlug, 'cookies', site.customDomain)} className={link}>
        {t('cookies')}
      </Link>
      <Link
        href={legalHref(site.tenantSlug, 'condiciones-contratacion', site.customDomain)}
        className={link}
      >
        {t('terms')}
      </Link>
      {analytics && (
        <button type="button" onClick={() => writeConsent(site.tenantSlug, null)} className={link}>
          {t('cookieSettings')}
        </button>
      )}
    </nav>
  );
  const areas = site.areaLinks ?? [];
  if (areas.length === 0) return legal;
  // Enlaces a las páginas de zona: Google las encuentra y entiende de qué van.
  return (
    <div className="flex flex-col gap-1">
      <nav aria-label={t('areasLabel')} className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {areas.map((a) => (
          <Link
            key={a.path}
            href={facilityHref(site.tenantSlug, a.path, locale, site.customDomain)}
            className={link}
          >
            {a.kind === 'nearby'
              ? tWeb('area.nearHeading', { city: a.name })
              : tWeb('city.heading', { city: a.name })}
          </Link>
        ))}
      </nav>
      {legal}
    </div>
  );
}
