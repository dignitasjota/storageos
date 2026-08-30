import { createTranslator } from 'next-intl';

import type { ContractSignViewDto } from '@storageos/shared';

import {
  getPublicWebMessages,
  intlLocaleFor,
  type PublicWebLocale,
} from '@/app/(public)/s/[slug]/i18n/messages';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Carga la vista de firma EN EL SERVIDOR (`cache: 'no-store'` — el token es
 * de un solo uso/sensible, no se puede cachear con ISR). Evita el waterfall
 * de `SignPageBody` (cliente: HTML en blanco → JS → hidratación → fetch).
 */
export async function getContractSignView(
  token: string,
  locale: PublicWebLocale,
): Promise<{ data: ContractSignViewDto | null; error: string | null }> {
  try {
    const res = await fetch(`${API_URL}/public/move-in/sign/${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });
    if (res.ok) {
      return { data: (await res.json()) as ContractSignViewDto, error: null };
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
    namespace: 'publicWeb.sign',
  });
  return t('invalidFallback');
}

/** Marca del operador extraída del DTO de firma (white-label del embudo). */
export function brandOf(view: ContractSignViewDto) {
  return {
    tenantName: view.tenantName,
    tenantSlug: view.tenantSlug,
    brandColor: view.brandColor,
    logoUrl: view.logoUrl,
  };
}
