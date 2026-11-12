'use client';

import { PLATFORM_ATTRIBUTION_KEY } from '@storageos/shared';
import { useEffect } from 'react';

import { currentTrafficSource, recordVisit } from '@/lib/attribution';

/**
 * Anota de dónde viene la visita a trasteros.pro (Google, un anuncio, una red
 * social…), sin datos personales, para que el formulario de contacto y el
 * registro lo guarden en el lead del panel admin.
 */
export function PlatformAttribution() {
  useEffect(() => recordVisit(PLATFORM_ATTRIBUTION_KEY), []);
  return null;
}

/** Origen de la visita a mandar con el formulario o el registro. */
export function platformTrafficFields(): {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
} {
  const origin = currentTrafficSource(PLATFORM_ATTRIBUTION_KEY);
  if (!origin) return {};
  return {
    ...(origin.source ? { utmSource: origin.source.slice(0, 120) } : {}),
    ...(origin.medium ? { utmMedium: origin.medium.slice(0, 120) } : {}),
    ...(origin.campaign ? { utmCampaign: origin.campaign.slice(0, 120) } : {}),
  };
}
