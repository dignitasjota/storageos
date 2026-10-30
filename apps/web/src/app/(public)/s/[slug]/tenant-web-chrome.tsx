import Image from 'next/image';
import Link from 'next/link';
import { createTranslator } from 'next-intl';

import { GoogleAnalyticsScript, TenantLegalLinks } from './google-analytics';
import { HtmlLang } from './html-lang';
import { LanguageSwitcher } from './i18n/language-switcher';
import {
  blogHref,
  bookHref,
  getPublicWebMessages,
  intlLocaleFor,
  landingHref,
} from './i18n/messages';
import { themeFor } from './promo/promo-theme';

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
  /**
   * Dominio propio verificado, o null — ver `facilityHref`/`blogHref`.
   * Opcional: `/book`/`/sign` (que también usan este marco) no reescriben
   * por dominio propio (`PASS_PREFIXES` en `resolveCustomDomainRoute`), así
   * que su DTO no lo trae; se trata como sin dominio propio en ese caso.
   */
  customDomain?: string | null;
  /** Plantilla de la web: las subpáginas toman su color, esquinas y tono. */
  webTemplate?: string;
  /** Cabecera del color de la marca (y el botón «Reservar» en blanco). */
  webHeaderBranded?: boolean;
}

/**
 * Logo de la cabecera igual que en la portada de cada plantilla (las que
 * traen su propia cabecera lo pintan más grande; Cabe lo pone en blanco sobre
 * la cabecera de color), para que landings, locales y blog no lo cambien.
 */
function headerLogo(template: string, branded: boolean) {
  switch (template) {
    case 'cabe':
      return {
        width: 264,
        height: 96,
        className: `h-16 w-auto object-contain sm:h-24 ${branded ? 'brightness-0 invert' : ''}`,
        wide: true,
      };
    case 'trstrom':
      return {
        width: 120,
        height: 48,
        className: 'h-10 w-auto object-contain sm:h-12',
        wide: true,
      };
    case 'onepagemovil':
      return { width: 130, height: 30, className: 'h-8 w-auto object-contain', wide: false };
    default:
      return { width: 120, height: 28, className: 'h-7 w-auto object-contain', wide: false };
  }
}

/** Sección de trasteros y precios de la portada de cada plantilla. */
const PRICES_ANCHOR: Record<string, string> = {
  onepage: 'espacios',
  escaparate: 'centros',
  corporate: 'centros',
  onepagemovil: 'trasteros',
  trstrom: 'trasteros',
  cabe: 'trasteros',
};

/** Plantillas con el pie oscuro (y la cabecera, en industrial). */
const DARK_FOOTER = new Set(['industrial', 'cabe', 'trstrom', 'onepagemovil']);

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
  hideReserve = false,
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
  /** Sin el botón «Reservar» (en la propia reserva y en la firma). */
  hideReserve?: boolean;
  children: ReactNode;
}) {
  const messages = await getPublicWebMessages(locale);
  const intlLocale = intlLocaleFor(locale);
  const t = createTranslator({ locale: intlLocale, messages, namespace: 'publicWeb.chrome' });
  const tCommon = createTranslator({ locale: intlLocale, messages, namespace: 'publicWeb.common' });
  const tBlog = createTranslator({ locale: intlLocale, messages, namespace: 'publicWeb.blog' });
  const template = data.webTemplate ?? 'default';
  const theme = themeFor(template, data.brandColor);
  const brand = theme.accent;
  const darkHeader = theme.dark;
  const branded = !!data.webHeaderBranded;
  const logo = headerLogo(template, branded);
  const darkFooter = DARK_FOOTER.has(template);
  const home = landingHref(data.tenantSlug, locale, data.customDomain);
  const pricesHref = `${home}#${PRICES_ANCHOR[template] ?? 'precios'}`;
  const reserveHref = bookHref(data.tenantSlug, locale, undefined, data.customDomain);
  const muted = branded
    ? 'text-white/80 hover:text-white'
    : darkHeader
      ? 'text-neutral-300 hover:text-white'
      : 'text-muted-foreground hover:text-foreground';
  // Resuelto AQUÍ (servidor) en vez de pasar `languageHrefBuilder` tal cual a
  // `LanguageSwitcher` (cliente) — una función no puede cruzar la frontera
  // Server → Client.
  const otherLocale: PublicWebLocale = locale === 'es' ? 'en' : 'es';
  const otherLocaleHref = languageHrefBuilder?.(otherLocale);
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const year = new Date().getUTCFullYear();

  return (
    <div className="flex min-h-screen flex-col">
      <GoogleAnalyticsScript measurementId={googleAnalyticsId ?? null} site={data} />
      <HtmlLang locale={locale} />
      <header
        className={
          branded
            ? 'border-b border-black/10 text-white'
            : darkHeader
              ? 'border-b border-neutral-800 bg-neutral-950 text-neutral-100'
              : 'border-b border-border/60 bg-background'
        }
        style={branded ? { backgroundColor: brand } : undefined}
      >
        <div
          className={`mx-auto flex items-center justify-between gap-3 whitespace-nowrap px-4 py-3 ${logo.wide ? 'max-w-7xl' : 'max-w-5xl'}`}
        >
          <Link href={home} className="flex min-w-0 shrink items-center gap-2 font-semibold">
            {data.logoUrl ? (
              <Image
                unoptimized
                src={data.logoUrl}
                alt={data.tenantName}
                width={logo.width}
                height={logo.height}
                className={logo.className}
              />
            ) : (
              <span className={theme.upper ? 'uppercase tracking-wide' : ''}>
                {data.tenantName}
              </span>
            )}
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href={pricesHref}
              className={`hidden text-sm transition-colors md:inline ${muted}`}
            >
              {t('prices')}
            </Link>
            {hasBlog && (
              <Link
                href={blogHref(data.tenantSlug, locale, data.customDomain)}
                className={`hidden text-sm transition-colors sm:inline ${muted}`}
              >
                {tBlog('title')}
              </Link>
            )}
            <LanguageSwitcher
              tenantSlug={data.tenantSlug}
              facilitySlug={facilitySlug}
              currentLocale={locale}
              otherLocaleHref={otherLocaleHref}
              customDomain={data.customDomain}
              onBrand={branded}
            />
            <Link
              href={portalHref}
              className={`hidden h-9 items-center border px-3 text-sm font-medium transition-colors sm:inline-flex ${theme.button} ${
                branded
                  ? 'border-white/40 hover:bg-white/10'
                  : darkHeader
                    ? 'border-neutral-700 hover:bg-neutral-800'
                    : 'hover:bg-accent'
              }`}
            >
              {t('clientAccess')}
            </Link>
            {!hideReserve && (
              <Link
                href={reserveHref}
                className={`inline-flex h-9 items-center px-4 text-sm font-medium shadow-sm transition-opacity hover:opacity-90 ${theme.button} ${
                  theme.upper ? 'uppercase tracking-wide' : ''
                } ${branded ? '' : darkHeader ? 'text-neutral-950' : 'text-white'}`}
                style={
                  branded
                    ? { backgroundColor: '#ffffff', color: brand }
                    : { backgroundColor: brand }
                }
              >
                {t('reserve')}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer
        className={
          darkFooter
            ? 'bg-neutral-950 text-neutral-400'
            : 'border-t border-border/60 text-muted-foreground'
        }
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {data.tenantName}
          </p>
          <TenantLegalLinks site={data} analytics={!!googleAnalyticsId} />
          <div className="flex items-center gap-4">
            <Link href={portalHref} className="transition hover:underline">
              {t('clientAccess')}
            </Link>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:underline"
            >
              {tCommon('createdWith', { name: SAAS_NAME })}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
