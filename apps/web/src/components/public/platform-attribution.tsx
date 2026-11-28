'use client';

import { LANDING_PATH_MAX, PLATFORM_ATTRIBUTION_KEY } from '@storageos/shared';
import { useEffect } from 'react';

import { CONSENT_EVENT, type CookieConsent } from '@/components/public/cookie-consent';
import { clearVisitOrigin, currentTrafficSource, recordVisit } from '@/lib/attribution';
import { captureSalesCodeFromUrl } from '@/lib/sales-code';
import { measurementAllowed } from '@/lib/tenant-consent';

/**
 * Anota de dónde viene la visita a trasteros.pro (Google, un anuncio, una red
 * social…), sin datos personales, para que el formulario de contacto y el
 * registro lo guarden en el lead del panel admin.
 */
export function PlatformAttribution() {
  useEffect(() => {
    // El enlace o el QR de un comercial (`?team=`) queda guardado: el
    // registro y los formularios lo llevan y la cuenta será suya.
    captureSalesCodeFromUrl();
    recordVisit(PLATFORM_ATTRIBUTION_KEY);
    // Si rechaza las cookies no necesarias estando en la página, se borra lo guardado.
    const onConsent = (e: Event) => {
      if ((e as CustomEvent<CookieConsent | null>).detail === 'necessary') {
        clearVisitOrigin(PLATFORM_ATTRIBUTION_KEY);
      }
    };
    window.addEventListener(CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(CONSENT_EVENT, onConsent);
  }, []);
  return null;
}

/** Origen de la visita a mandar con el formulario o el registro. */
export function platformTrafficFields(): {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPath?: string;
} {
  // Con «Solo necesarias» no se envía de dónde viene la visita.
  if (!measurementAllowed(PLATFORM_ATTRIBUTION_KEY)) return {};
  const origin = currentTrafficSource(PLATFORM_ATTRIBUTION_KEY);
  if (!origin) return {};
  return {
    ...(origin.source ? { utmSource: origin.source.slice(0, 120) } : {}),
    ...(origin.medium ? { utmMedium: origin.medium.slice(0, 120) } : {}),
    ...(origin.campaign ? { utmCampaign: origin.campaign.slice(0, 120) } : {}),
    // Primera página que vio (SEO Avanzado reparte las altas y demos por ella).
    ...(origin.landing ? { landingPath: origin.landing.slice(0, LANDING_PATH_MAX) } : {}),
  };
}
