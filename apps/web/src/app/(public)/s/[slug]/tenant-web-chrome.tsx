import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { GoogleAnalyticsScript } from './google-analytics';
import { LanguageSwitcher } from './i18n/language-switcher';
import { blogHref } from './i18n/messages';

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
 */
export function TenantWebChrome({
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
  const t = useTranslations('publicWeb.chrome');
  const tCommon = useTranslations('publicWeb.common');
  const tBlog = useTranslations('publicWeb.blog');
  const brand = data.brandColor ?? '#2563EB';
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
              hrefBuilder={languageHrefBuilder}
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
