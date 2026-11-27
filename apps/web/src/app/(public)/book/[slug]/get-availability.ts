import { createTranslator } from 'next-intl';

import type { BookingAvailabilityDto } from '@storageos/shared';
import type { Metadata } from 'next';

import {
  getPublicWebMessages,
  intlLocaleFor,
  type PublicWebLocale,
} from '@/app/(public)/s/[slug]/i18n/messages';
import { NOINDEX_ROBOTS, tenantPageMetadata } from '@/lib/seo/tenant-metadata';
import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

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
      `${API_URL}/v1/public/move-in/book/${encodeURIComponent(slug)}/availability`,
      { headers: internalApiHeaders(), cache: 'no-store' },
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

/**
 * Metadatos de la página de reserva con la marca del tenant (sin la plantilla
 * «· TrasterOS» ni la descripción del layout raíz: en su dominio propio es su
 * web). Es una página transaccional: lleva `noindex` (también por cabecera).
 */
export async function bookingMetadata(slug: string, locale: PublicWebLocale): Promise<Metadata> {
  const { data } = await getBookingAvailability(slug, locale);
  if (!data) {
    return {
      title: { absolute: locale === 'en' ? 'Book' : 'Reservar' },
      robots: NOINDEX_ROBOTS,
    };
  }
  const en = locale === 'en';
  const title = en
    ? `Book a storage unit online · ${data.tenantName}`
    : `Reserva tu trastero online · ${data.tenantName}`;
  const description = en
    ? `Book a storage unit with ${data.tenantName}: pick the size and the location, sign and pay in minutes.`
    : `Reserva online un trastero en ${data.tenantName}: elige tamaño y local, firma y paga en minutos.`;
  return {
    ...tenantPageMetadata({ tenantName: data.tenantName, title, description, locale }),
    robots: NOINDEX_ROBOTS,
  };
}
