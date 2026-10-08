import type { PlatformFounderOfferDto } from '@storageos/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Oferta fundador de la sección de precios (panel admin → Web de TrasterOS).
 * `null` si está desactivada o la API no responde: la landing la omite.
 */
export async function fetchFounderOffer(): Promise<PlatformFounderOfferDto | null> {
  try {
    const res = await fetch(`${API_URL}/v1/platform-founder-offer`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { offer: PlatformFounderOfferDto | null };
    return body.offer;
  } catch {
    return null;
  }
}
