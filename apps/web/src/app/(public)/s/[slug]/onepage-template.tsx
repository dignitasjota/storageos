import { Clock, CreditCard, Headset, KeyRound, Ruler, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ContactForm } from './contact-form';
import { bookHref as buildBookHref, type PublicWebLocale } from './i18n/messages';
import { OnePageNav, type OnePageNavItem } from './onepage-nav';
import { StorageCalculator } from './storage-calculator';
import {
  cities,
  formatPrice,
  isUrgentStock,
  OpeningHoursInfo,
  PromoBanner,
  useHeadlineFallback,
  WhatsAppButton,
} from './templates';

import type { PublicLandingDto, PublicLandingFacilityDto } from '@storageos/shared';
import type { LucideIcon } from 'lucide-react';

const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';

/** Tipos de trastero distintos (por nombre) con su área y precio de referencia. */
function distinctUnitTypes(data: PublicLandingDto) {
  const map = new Map<
    string,
    { name: string; areaM2: number | null; priceMonthly: number; available: number }
  >();
  for (const f of data.facilities) {
    for (const t of f.unitTypes) {
      const prev = map.get(t.name);
      if (!prev) {
        map.set(t.name, {
          name: t.name,
          areaM2: t.areaM2,
          priceMonthly: t.priceMonthly,
          available: t.available,
        });
      } else {
        prev.available += t.available;
        if ((t.areaM2 ?? Infinity) < (prev.areaM2 ?? Infinity)) prev.areaM2 = t.areaM2;
        if (t.priceMonthly < prev.priceMonthly) prev.priceMonthly = t.priceMonthly;
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.areaM2 ?? 0) - (b.areaM2 ?? 0));
}

type ServiceItem = { icon: LucideIcon; title: string; text: string };
type FaqItem = { question: string; answer: string };

/** Iconos fijos por posición (el tenant edita el texto, no el icono). */
const SERVICE_ICONS: LucideIcon[] = [Clock, ShieldCheck, KeyRound, Ruler, CreditCard, Headset];

function FacilityBlock({ f, locale }: { f: PublicLandingFacilityDto; locale: PublicWebLocale }) {
  const t = useTranslations('publicWeb.onepage');
  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <h3 className="text-lg font-semibold">{f.name}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {[f.address, f.postalCode, f.city].filter(Boolean).join(', ') || '—'}
      </p>
      {(f.contactPhone || f.contactEmail) && (
        <p className="mt-1 text-sm text-muted-foreground">
          {[f.contactPhone, f.contactEmail].filter(Boolean).join(' · ')}
        </p>
      )}
      {f.unitTypes.length > 0 && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {f.unitTypes.map((unitType) => (
            <li
              key={unitType.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span className="font-medium">{unitType.name}</span>
              <span className="font-semibold">
                {formatPrice(unitType.priceMonthly * 1.21, locale)}
                <span className="text-xs font-normal text-muted-foreground">{t('perMonth')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Plantilla «una página»: menú superior fijo cuyos botones se deslizan a cada
 * sección (Trasteros, Espacios, Servicios, FAQ, Contacto) y «Área cliente» que
 * lleva al portal del inquilino. Es AUTOCONTENIDA (trae su propia cabecera y
 * pie); la página no la envuelve en `TenantWebChrome`.
 */
export function OnePageTemplate({
  data,
  locale,
}: {
  data: PublicLandingDto;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.onepage');
  const tCommon = useTranslations('publicWeb.common');
  const tChrome = useTranslations('publicWeb.chrome');
  const tFaq = useTranslations('publicWeb.faq');
  const brand = data.brandColor ?? '#2563EB';
  const where = cities(data);
  const trasterosLabel = useHeadlineFallback(where);
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const bookHref = buildBookHref(data.tenantSlug, locale);
  const types = distinctUnitTypes(data);
  const defaultFaqs = t.raw('faqs') as FaqItem[];
  const faqs = data.faqs.length > 0 ? data.faqs : defaultFaqs;

  // Copy editable por el tenant (Ajustes → Web). Vacío → textos por defecto.
  const content = data.webContent;
  const heroSubtitle =
    content?.heroSubtitle?.trim() || t('heroSubtitle', { tenantName: data.tenantName });
  const defaultServices = t.raw('services') as { title: string; text: string }[];
  const svcCustom = (content?.services ?? [])
    .filter((s) => s.title.trim())
    .map((s, i) => ({
      icon: SERVICE_ICONS[i % SERVICE_ICONS.length]!,
      title: s.title,
      text: s.text ?? '',
    }));
  const services: ServiceItem[] =
    svcCustom.length > 0
      ? svcCustom
      : defaultServices.map((s, i) => ({ icon: SERVICE_ICONS[i % SERVICE_ICONS.length]!, ...s }));

  const navItems: OnePageNavItem[] = [
    { id: 'trasteros', label: trasterosLabel },
    { id: 'espacios', label: t('nav.spaces') },
    { id: 'servicios', label: t('nav.services') },
    { id: 'faq', label: t('nav.faq') },
    { id: 'contacto', label: tCommon('contactSectionTitle') },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <OnePageNav
        items={navItems}
        brand={brand}
        tenantName={data.tenantName}
        logoUrl={data.logoUrl}
        portalHref={portalHref}
      />

      {/* Hero */}
      <section
        className="px-4 py-20 text-center text-white sm:py-28"
        style={{ background: `linear-gradient(135deg, ${brand}, ${brand}cc)` }}
      >
        {data.logoUrl && (
          <Image
            src={data.logoUrl}
            alt={data.tenantName}
            width={220}
            height={64}
            className="mx-auto mb-6 h-16 w-auto object-contain drop-shadow"
          />
        )}
        <h1 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
          {data.webHeadline || trasterosLabel}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg opacity-90">{heroSubtitle}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={bookHref}
            className="inline-flex h-12 items-center rounded-full bg-white px-8 text-sm font-semibold shadow-lg transition-transform hover:scale-105"
            style={{ color: brand }}
          >
            {tCommon('reserveNow')}
          </Link>
          <Link
            href={portalHref}
            className="inline-flex h-12 items-center rounded-full border border-white/70 px-8 text-sm font-semibold text-white transition-colors hover:bg-white/10"
          >
            {tChrome('clientAccess')}
          </Link>
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4">
        <div className="pt-6">
          <PromoBanner data={data} />
        </div>
        {/* Trasteros en <ciudad> */}
        <section id="trasteros" className="scroll-mt-20 py-14">
          <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">{trasterosLabel}</h2>
          {data.webAbout && (
            <p className="mx-auto mb-8 max-w-2xl whitespace-pre-line text-center text-sm leading-relaxed text-muted-foreground">
              {data.webAbout}
            </p>
          )}
          {data.facilities.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {data.facilities.map((f) => (
                <FacilityBlock key={f.id} f={f} locale={locale} />
              ))}
            </div>
          ) : (
            <p className="rounded-md border bg-card px-4 py-10 text-center text-muted-foreground">
              {t('noAvailability')}
            </p>
          )}
        </section>

        {/* Espacios (tamaños) + calculadora */}
        <section id="espacios" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">{t('sizesTitle')}</h2>
          <p className="mb-6 text-center text-sm text-muted-foreground">{t('sizesSubtitle')}</p>
          {types.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {types.map((unitType) => {
                const soldOut = unitType.available === 0;
                const urgent = isUrgentStock(unitType.available);
                return (
                  <div
                    key={unitType.name}
                    className={`rounded-lg border bg-card p-5 text-center shadow-sm ${soldOut ? 'opacity-60' : ''}`}
                  >
                    <p className="text-lg font-semibold">{unitType.name}</p>
                    {unitType.areaM2 != null && (
                      <p className="text-sm text-muted-foreground">{unitType.areaM2} m²</p>
                    )}
                    <p className="mt-2 text-2xl font-bold" style={{ color: brand }}>
                      {formatPrice(unitType.priceMonthly * 1.21, locale)}
                      <span className="text-sm font-normal text-muted-foreground">
                        {t('perMonth')}
                      </span>
                    </p>
                    {urgent && (
                      <p className="mt-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                        {unitType.available === 1
                          ? tCommon('urgentOne')
                          : tCommon('urgentFew', { count: unitType.available })}
                      </p>
                    )}
                    {soldOut ? (
                      <p className="mt-3 text-sm font-medium text-destructive">
                        {tCommon('soldOut')}
                      </p>
                    ) : (
                      <Link
                        href={bookHref}
                        className="mt-3 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white"
                        style={{ backgroundColor: brand }}
                      >
                        {t('reserve')}
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-4">
            <StorageCalculator data={data} brand={brand} locale={locale} />
          </div>
        </section>

        {/* Servicios */}
        <section id="servicios" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">
            {t('servicesTitle')}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s) => (
              <div key={s.title} className="rounded-lg border bg-card p-5 shadow-sm">
                <s.icon className="h-6 w-6" style={{ color: brand }} />
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">{tFaq('title')}</h2>
          <div className="mx-auto max-w-2xl divide-y rounded-lg border bg-card">
            {faqs.map((f, i) => (
              <details key={i} className="group px-5 py-4">
                <summary className="cursor-pointer list-none font-medium marker:content-none">
                  {f.question}
                </summary>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {f.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* Contacto */}
        <section id="contacto" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">
            {tCommon('contactSectionTitle')}
          </h2>
          <p className="mb-6 text-center text-sm text-muted-foreground">
            {tCommon('contactSectionSubtitle')}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              {data.facilities.map((f) => (
                <div key={f.id} className="rounded-lg border bg-card p-4 text-sm">
                  <p className="font-medium">{f.name}</p>
                  <p className="text-muted-foreground">
                    {[f.address, f.postalCode, f.city].filter(Boolean).join(', ') || '—'}
                  </p>
                  {f.contactPhone && (
                    <a
                      href={`tel:${f.contactPhone}`}
                      className="block text-muted-foreground hover:text-foreground"
                    >
                      {f.contactPhone}
                    </a>
                  )}
                  {f.contactEmail && (
                    <a
                      href={`mailto:${f.contactEmail}`}
                      className="block text-muted-foreground hover:text-foreground"
                    >
                      {f.contactEmail}
                    </a>
                  )}
                  {f.contactPhone && (
                    <div className="mt-1">
                      <WhatsAppButton phone={f.contactPhone} tenantName={data.tenantName} />
                    </div>
                  )}
                  <div className="mt-1">
                    <OpeningHoursInfo hours={f.openingHours} timezone={f.timezone} />
                  </div>
                </div>
              ))}
            </div>
            {data.contactEnabled && (
              <div>
                <ContactForm slug={data.tenantSlug} brand={brand} />
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Pie */}
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getUTCFullYear()} {data.tenantName}
          </p>
          <div className="flex items-center gap-4">
            <Link href={portalHref} className="transition hover:text-foreground">
              {tChrome('clientAccess')}
            </Link>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-foreground"
            >
              {tCommon('createdWith', { name: 'TrasterOS' })}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
