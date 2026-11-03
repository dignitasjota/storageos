'use client';

import {
  splitBlogContent,
  BLOG_WIDGET_LABELS,
  type BlogComparisonColumn,
  type BlogWidget,
} from '@storageos/shared';
import { ArrowRight, MapPin } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { trackEvent } from '../google-analytics';
import { bookHrefFor, facilityHref, type PublicWebLocale } from '../i18n/messages';
import { formatPrice, grossPrice } from '../price-format';
import { themeFor } from '../promo/promo-theme';
import { resolveSiteHref, type SiteLinkContext } from '../site-links';
import { StorageCalculator } from '../storage-calculator';

import type { PublicLandingDto } from '@storageos/shared';

import { MarkdownView } from '@/components/public/markdown-view';

/**
 * Cuerpo de una entrada del blog: el Markdown con sus enlaces a la web
 * resueltos, los botones de llamada a la acción y los widgets (calculadora,
 * tamaños y precios, locales). Sin `landing` (la vista previa del panel), los
 * widgets salen como un recuadro con su nombre.
 */
export function BlogContent({
  markdown,
  ctx,
  brandColor,
  landing,
}: {
  markdown: string;
  ctx: SiteLinkContext;
  brandColor: string | null;
  landing: PublicLandingDto | null;
}) {
  const theme = themeFor(ctx.webTemplate, brandColor);
  const resolve = (href: string) => resolveSiteHref(href, ctx);
  const siteOrigin = ctx.customDomain ? `https://${ctx.customDomain}` : null;
  return (
    <div className="space-y-6">
      {splitBlogContent(markdown).map((block, i) => {
        if (block.type === 'markdown') {
          return (
            <MarkdownView
              key={i}
              content={block.text}
              resolveHref={resolve}
              siteOrigin={siteOrigin}
            />
          );
        }
        if (block.type === 'button') {
          const href = resolve(block.href);
          const external = href.startsWith('http') && !(siteOrigin && href.startsWith(siteOrigin));
          return (
            <div key={i}>
              <Link
                href={href}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={`inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 ${theme.button} ${theme.upper ? 'uppercase tracking-wide' : ''}`}
                style={{ backgroundColor: theme.accent }}
              >
                {block.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          );
        }
        if (block.type === 'comparison') {
          return <BlogComparison key={i} columns={block.columns} />;
        }
        return landing ? (
          <BlogWidgetView
            key={i}
            widget={block.widget}
            landing={landing}
            ctx={ctx}
            brand={theme.accent}
          />
        ) : (
          <div
            key={i}
            className="rounded-md border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground"
          >
            {BLOG_WIDGET_LABELS[block.widget]}: en la web se verá con tus tamaños y precios reales.
          </div>
        );
      })}
    </div>
  );
}

function BlogWidgetView({
  widget,
  landing,
  ctx,
  brand,
}: {
  widget: BlogWidget;
  landing: PublicLandingDto;
  ctx: SiteLinkContext;
  brand: string;
}) {
  const t = useTranslations('publicWeb.common');
  const locale: PublicWebLocale = ctx.locale;
  if (widget === 'calculadora') {
    // La calculadora trae su propio margen superior y su ancla.
    return (
      <div className="-mt-8">
        <StorageCalculator data={landing} brand={brand} locale={locale} />
      </div>
    );
  }
  const facilities = landing.facilities;
  if (facilities.length === 0) return null;
  if (widget === 'tamanos') {
    return (
      <div className="space-y-6 rounded-md border p-4">
        {facilities.map((f) => (
          <div key={f.id}>
            {facilities.length > 1 && <p className="font-semibold">{f.name}</p>}
            <BlogUnitTypes f={f} locale={locale} site={landing} brand={brand} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {facilities.map((f) => {
        const available = f.unitTypes.filter((u) => u.available > 0);
        const from = available.length > 0 ? Math.min(...available.map((u) => grossPrice(u))) : null;
        const inner = (
          <>
            <span className="font-medium">{f.name}</span>
            {(f.address || f.city) && (
              <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                {[f.address, f.city].filter(Boolean).join(', ')}
              </p>
            )}
            {from !== null && (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('from')} {formatPrice(from, locale)} {t('perMonthVatIncl')}
              </p>
            )}
          </>
        );
        return (
          <li key={f.id}>
            {f.publicSlug ? (
              <Link
                href={facilityHref(ctx.tenantSlug, f.publicSlug, locale, ctx.customDomain)}
                className="block rounded-md border p-3 hover:border-primary hover:bg-muted/40"
              >
                {inner}
              </Link>
            ) : (
              <div className="rounded-md border p-3">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Tamaños y precios del local dentro de una entrada del blog: sin el número de
 * trasteros libres (el texto del post dura más que la disponibilidad) y con un
 * enlace para contratar cada tamaño (la reserva sale con el local y el tamaño
 * ya elegidos). Un tamaño agotado lleva a la lista de espera.
 */
function BlogUnitTypes({
  f,
  locale,
  site,
  brand,
}: {
  f: PublicLandingDto['facilities'][number];
  locale: PublicWebLocale;
  site: PublicLandingDto;
  brand: string;
}) {
  const t = useTranslations('publicWeb.common');
  if (f.unitTypes.length === 0) {
    return <p className="mt-4 text-sm text-muted-foreground">{t('noAvailabilityShort')}</p>;
  }
  return (
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">
      {f.unitTypes.map((unitType) => {
        const soldOut = unitType.available === 0;
        return (
          <li
            key={unitType.id}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <span className="min-w-0">
              <span className="block font-medium">{unitType.name}</span>
              {soldOut ? (
                <span className="text-xs font-medium text-destructive">{t('soldOut')}</span>
              ) : (
                <span className="font-semibold">
                  {t('from')} {formatPrice(grossPrice(unitType), locale)}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t('perMonthVatIncl')}
                  </span>
                </span>
              )}
            </span>
            {soldOut ? (
              <Link
                href={bookHrefFor(site, locale, {
                  facilityId: f.id,
                  unitTypeId: unitType.id,
                  waitlist: true,
                })}
                onClick={() => trackEvent('waitlist_notify_click', { location: 'blog' })}
                className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                {t('notifyMe')}
              </Link>
            ) : (
              <Link
                href={bookHrefFor(site, locale, { facilityId: f.id, unitTypeId: unitType.id })}
                onClick={() => trackEvent('cta_reservar_click', { location: 'blog_sizes' })}
                className="shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold text-white"
                style={{ backgroundColor: brand }}
              >
                {t('hireThisSize')}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Columnas de la rejilla según cuántas haya (en el móvil, 2 o 1 por fila). */
const COMPARISON_GRID: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
};

/**
 * Comparativa dentro de un post: una celda por columna con su imagen, el título
 * (h3) y el subtítulo (h4). El texto alternativo de la imagen es el título.
 */
function BlogComparison({ columns }: { columns: BlogComparisonColumn[] }) {
  return (
    <div
      className={`grid gap-px overflow-hidden rounded-md border bg-border ${
        COMPARISON_GRID[columns.length] ?? 'grid-cols-2'
      }`}
    >
      {columns.map((c, i) => (
        <div key={i} className="flex flex-col bg-background">
          {c.imageUrl ? (
            // Imágenes del tenant o de fuera (https): sin optimizar con next/image.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={c.imageUrl}
              alt={c.title}
              loading="lazy"
              className="aspect-[4/3] w-full object-cover"
            />
          ) : null}
          <div className="space-y-1 p-3 text-center">
            <h3 className="text-base font-semibold text-foreground">{c.title}</h3>
            {c.subtitle && <h4 className="text-sm text-muted-foreground">{c.subtitle}</h4>}
          </div>
        </div>
      ))}
    </div>
  );
}
