import type { PlatformFounderOfferDto } from '@storageos/shared';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

/**
 * Oferta fundador de la sección de precios (panel admin → Web de TrasterOS).
 * `null` si está desactivada o la API no responde: la landing la omite.
 */
export async function fetchFounderOffer(): Promise<PlatformFounderOfferDto | null> {
  try {
    const res = await fetch(`${API_URL}/v1/platform-founder-offer`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { offer: PlatformFounderOfferDto | null };
    return body.offer;
  } catch {
    return null;
  }
}
