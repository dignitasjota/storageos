import { createTranslator } from 'next-intl';

import type { BookingAvailabilityDto } from '@storageos/shared';

import {
  getPublicWebMessages,
  intlLocaleFor,
  type PublicWebLocale,
} from '@/app/(public)/s/[slug]/i18n/messages';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Carga la disponibilidad de reserva EN EL SERVIDOR (`cache: 'no-store'` —
 * el stock cambia constantemente, no se puede cachear como la landing). Sin
 * esto, `BookPageBody` (cliente) hacía el fetch en un `useEffect` tras
 * hidratar: HTML en blanco → JS → hidratación → fetch → recién ahí contenido
 * real. Resolviendo aquí, el HTML inicial ya trae los datos.
 *
 * No usa `apiFetch` (cliente, con manejo de auth) — es un fetch público
 * directo, mismo patrón que `getLanding`/`getFacility`.
 */
export async function getBookingAvailability(
  slug: string,
  locale: PublicWebLocale,
): Promise<{ data: BookingAvailabilityDto | null; error: string | null }> {
  try {
    const res = await fetch(
      `${API_URL}/public/move-in/book/${encodeURIComponent(slug)}/availability`,
      { cache: 'no-store' },
    );
    if (res.ok) {
      return { data: (await res.json()) as BookingAvailabilityDto, error: null };
    }
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return { data: null, error: body?.message ?? (await fallbackMessage(locale)) };
  } catch {
    return { data: null, error: await fallbackMessage(locale) };
  }
}

async function fallbackMessage(locale: PublicWebLocale): Promise<string> {
  const messages = await getPublicWebMessages(locale);
  const t = createTranslator({
    locale: intlLocaleFor(locale),
    messages,
    namespace: 'publicWeb.book',
  });
  return t('notAvailableFallback');
}
