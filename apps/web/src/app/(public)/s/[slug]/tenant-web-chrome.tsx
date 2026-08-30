import Image from 'next/image';
import Link from 'next/link';
import { createTranslator } from 'next-intl';

import { GoogleAnalyticsScript } from './google-analytics';
import { LanguageSwitcher } from './i18n/language-switcher';
import { blogHref, getPublicWebMessages, intlLocaleFor } from './i18n/messages';

import type { PublicWebLocale } from './i18n/messages';
import type { ReactNode } from 'react';

const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';
const SAAS_NAME = 'TrasterOS';

/** Datos mínimos de marca del tenant (los comparten la landing y la página por local). */
interface TenantBrand {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
}

/**
 * Marco WHITE-LABEL de la web pública del tenant (`/s/[slug]` y su dominio
 * propio). Cabecera + pie del OPERADOR, sin la marca de la plataforma: el
 * «Acceso clientes» lleva al **portal del inquilino** (con el slug precargado),
 * nunca al login de la plataforma. La única referencia a la plataforma es un
 * discreto «Creado con TrasterOS» en el pie.
 *
 * Server Component (sin `'use client'`): el header/footer en sí no tiene
 * interactividad — solo `LanguageSwitcher` (cliente, por su `useTranslations`)
 * y `GoogleAnalyticsScript` (universal) la necesitan, y ambos se renderizan
 * aquí como islas. Evita enviar el JS de este marco (presente en TODA la web
 * pública) al navegador. Traducciones resueltas con `createTranslator`
 * (función pura, no depende de `NextIntlClientProvider`) sobre el catálogo
 * AISLADO de la web pública — no confundir con `getTranslations()` de
 * `next-intl/server`, que leería el catálogo GLOBAL equivocado.
 */
export async function TenantWebChrome({
  data,
  locale,
  facilitySlug,
  hasBlog,
  googleAnalyticsId,
  languageHrefBuilder,
  children,
}: {
  data: TenantBrand;
  locale: PublicWebLocale;
  facilitySlug?: string;
  /** Muestra el enlace "Blog" en la cabecera (el tenant tiene entradas publicadas). */
  hasBlog?: boolean;
  /** Measurement ID de Google Analytics 4, o null/undefined si no lo configuró. */
  googleAnalyticsId?: string | null;
  /** Fuera de `/s/[slug]` (reserva, firma) para que el selector de idioma
   *  se quede en la misma página en vez de saltar a la landing. */
  languageHrefBuilder?: (locale: PublicWebLocale) => string;
  children: ReactNode;
}) {
  const messages = await getPublicWebMessages(locale);
  const intlLocale = intlLocaleFor(locale);
  const t = createTranslator({ locale: intlLocale, messages, namespace: 'publicWeb.chrome' });
  const tCommon = createTranslator({ locale: intlLocale, messages, namespace: 'publicWeb.common' });
  const tBlog = createTranslator({ locale: intlLocale, messages, namespace: 'publicWeb.blog' });
  const brand = data.brandColor ?? '#2563EB';
  // Resuelto AQUÍ (servidor) en vez de pasar `languageHrefBuilder` tal cual a
  // `LanguageSwitcher` (cliente) — una función no puede cruzar la frontera
  // Server → Client.
  const otherLocale: PublicWebLocale = locale === 'es' ? 'en' : 'es';
  const otherLocaleHref = languageHrefBuilder?.(otherLocale);
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const year = new Date().getUTCFullYear();

  return (
    <div className="flex min-h-screen flex-col">
      <GoogleAnalyticsScript measurementId={googleAnalyticsId ?? null} />
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            {data.logoUrl ? (
              <Image
                src={data.logoUrl}
                alt={data.tenantName}
                width={120}
                height={28}
                className="h-7 w-auto object-contain"
              />
            ) : (
              <span>{data.tenantName}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasBlog && (
              <Link
                href={blogHref(data.tenantSlug, locale)}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {tBlog('title')}
              </Link>
            )}
            <LanguageSwitcher
              tenantSlug={data.tenantSlug}
              facilitySlug={facilitySlug}
              currentLocale={locale}
              otherLocaleHref={otherLocaleHref}
            />
            <Link
              href={portalHref}
              className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
              style={{ backgroundColor: brand }}
            >
              {t('clientAccess')}
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {data.tenantName}
          </p>
          <div className="flex items-center gap-4">
            <Link href={portalHref} className="transition hover:text-foreground">
              {t('clientAccess')}
            </Link>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-foreground"
            >
              {tCommon('createdWith', { name: SAAS_NAME })}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
