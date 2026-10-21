import {
  areaPagePath,
  cityFromPageSlug,
  resolveAreaPages,
  type AreaPageFaq,
  type PublicLandingDto,
  type ResolvedAreaPage,
} from '@storageos/shared';
import { notFound, permanentRedirect } from 'next/navigation';
import { createTranslator, NextIntlClientProvider } from 'next-intl';

import { FacilityBody } from '../[facility]/facility-body';
import { getFacility } from '../[facility]/facility-shared';
import {
  cityPageHref,
  getPublicWebMessages,
  intlLocaleFor,
  landingHref,
  type PublicWebLocale,
} from '../i18n/messages';
import { getLanding, siteUrl } from '../landing-shared';
import { faqPageLd, localBusinessFields } from '../local-business-ld';
import { formatPrice, grossPrice } from '../price-format';
import { themeFor } from '../promo/promo-theme';
import { TenantWebChrome } from '../tenant-web-chrome';
import { WhatsappFloatButton } from '../whatsapp-float-button';

import { CityBody } from './city-body';

import type { Metadata } from 'next';

import { safeJsonLd } from '@/lib/json-ld';

type Facility = PublicLandingDto['facilities'][number];
type AreaPage = ResolvedAreaPage<Facility>;

/** Página de zona (`trasteros-en-<zona>`): ciudad con locales o zona cercana, o null. */
export async function getCityPage(
  slug: string,
  pageSlug: string,
): Promise<{ data: PublicLandingDto; page: AreaPage; pages: AreaPage[] } | null> {
  const city = cityFromPageSlug(pageSlug);
  if (!city) return null;
  const data = await getLanding(slug);
  if (!data || data.webTemplate === 'external') return null;
  const pages = resolveAreaPages(data.facilities, data.areaPages ?? []);
  const page = pages.find((p) => p.slug === city);
  return page ? { data, page, pages } : null;
}

/** A dónde lleva la dirección cuando no tiene página propia (un solo local: la portada). */
function redirectUrl(data: PublicLandingDto, page: AreaPage, locale: PublicWebLocale) {
  return page.redirect ? landingHref(data.tenantSlug, locale, data.customDomain) : null;
}

function minPrice(page: AreaPage): number | null {
  const prices = page.facilities.flatMap((f) =>
    f.unitTypes.filter((u) => u.available > 0).map((u) => grossPrice(u)),
  );
  return prices.length > 0 ? Math.min(...prices) : null;
}

/** Preguntas visibles: las propias y, después, las generadas que aplican. */
async function pageFaqs(
  data: PublicLandingDto,
  page: AreaPage,
  locale: PublicWebLocale,
): Promise<AreaPageFaq[]> {
  const messages = await getPublicWebMessages(locale);
  const t = createTranslator({
    locale: intlLocaleFor(locale),
    messages,
    namespace: 'publicWeb.city',
  });
  const min = minPrice(page);
  const price = min != null ? formatPrice(min, locale) : null;
  const own = page.content?.faqs ?? [];
  const generated: AreaPageFaq[] = [];
  if (page.kind === 'city') {
    generated.push({
      question: t('q1', { city: page.name }),
      answer: price
        ? t('a1', { city: page.name, tenantName: data.tenantName, price })
        : t('a1NoPrice'),
    });
    generated.push({
      question: t('q2', { city: page.name, tenantName: data.tenantName }),
      answer: t('a2', {
        city: page.name,
        count: page.facilities.length,
        addresses: page.facilities
          .map((f) => [f.name, f.address].filter(Boolean).join(', '))
          .join('; '),
      }),
    });
  }
  generated.push({ question: t('q3'), answer: t('a3') });
  const seen = new Set(own.map((f) => f.question.trim().toLowerCase()));
  return [...own, ...generated.filter((f) => !seen.has(f.question.trim().toLowerCase()))];
}

export async function buildCityMetadata(
  slug: string,
  pageSlug: string,
  locale: PublicWebLocale,
): Promise<Metadata | null> {
  const found = await getCityPage(slug, pageSlug);
  if (!found) return null;
  const { data, page } = found;
  // Lleva a otra página (la portada o la ficha del local): no se indexa.
  if (page.redirect) return { robots: { index: false, follow: true } };
  const min = minPrice(page);
  const price = min != null ? formatPrice(min, locale) : null;
  const near = page.kind === 'nearby';
  const names = page.facilities.map((f) => f.name).join(', ');
  // Los textos propios están en español: en inglés se usan los generados.
  const own = locale === 'es' ? page.content : null;
  const title =
    own?.seoTitle ||
    (locale === 'en'
      ? `Storage units ${near ? 'near' : 'in'} ${page.name} · ${data.tenantName}`
      : `Trasteros ${near ? 'cerca de' : 'en'} ${page.name} · ${data.tenantName}`);
  const description =
    own?.seoDescription ||
    (near
      ? locale === 'en'
        ? `Storage units near ${page.name}: ${names} (${data.tenantName})${price ? `, from ${price}/month (VAT incl.)` : ''}. Check sizes and book online.`
        : `Trasteros cerca de ${page.name}: ${names} (${data.tenantName})${price ? `, desde ${price}/mes (IVA incl.)` : ''}. Consulta tamaños y reserva online.`
      : locale === 'en'
        ? `${page.facilities.length} storage locations of ${data.tenantName} in ${page.name}${price ? `, from ${price}/month (VAT incl.)` : ''}. Check sizes and availability and book online.`
        : `${page.facilities.length === 1 ? 'Un centro' : `${page.facilities.length} centros`} de ${data.tenantName} en ${page.name}${price ? `, desde ${price}/mes (IVA incl.)` : ''}. Consulta tamaños y disponibilidad y reserva online.`);
  const es = cityPageHref(slug, page.slug, 'es', data.customDomain);
  const en = cityPageHref(slug, page.slug, 'en', data.customDomain);
  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical: locale === 'en' ? en : es,
      languages: { es, en, 'x-default': es },
    },
    // Una zona cercana sin texto propio suficiente no se indexa.
    robots: { index: page.indexable, follow: true },
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: data.tenantName,
      locale: locale === 'en' ? 'en_GB' : 'es_ES',
    },
  };
}

export async function CityPageBody({
  slug,
  pageSlug,
  locale,
}: {
  slug: string;
  pageSlug: string;
  locale: PublicWebLocale;
}) {
  const found = await getCityPage(slug, pageSlug);
  if (!found) notFound();
  const { data, page, pages } = found;
  const target = redirectUrl(data, page, locale);
  if (target) permanentRedirect(target);

  const messages = await getPublicWebMessages(locale);
  const faqs = await pageFaqs(data, page, locale);

  // Único local de la ciudad: la página muestra su ficha completa.
  const sole = page.soleFacility?.publicSlug
    ? await getFacility(slug, page.soleFacility.publicSlug)
    : null;
  if (sole) {
    const facilityData = {
      ...sole,
      brandColor: themeFor(sole.webTemplate, sole.brandColor).accent,
    };
    return (
      <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
        <TenantWebChrome
          data={facilityData}
          locale={locale}
          hasBlog={sole.hasBlog}
          googleAnalyticsId={sole.googleAnalyticsId}
          languageHrefBuilder={(l) => cityPageHref(slug, page.slug, l, data.customDomain)}
        >
          <FacilityBody
            data={facilityData}
            slug={slug}
            facilitySlug={sole.facility.publicSlug ?? areaPagePath(page.slug)}
            locale={locale}
            asCityPage={{ path: areaPagePath(page.slug), faqs }}
          />
        </TenantWebChrome>
        <WhatsappFloatButton number={sole.whatsappNumber} facilityName={sole.facility.name} />
      </NextIntlClientProvider>
    );
  }

  // El texto de las demás páginas no viaja al navegador.
  const site = { ...data, areaPages: [] };
  const min = minPrice(page);
  const base = data.customDomain ? `https://${data.customDomain}` : `${siteUrl()}/s/${slug}`;
  const pageUrl = `${base}/${areaPagePath(page.slug)}`;
  const served = [
    ...(page.kind === 'nearby' ? [page.name] : []),
    ...(page.content?.nearbyAreas ?? []),
  ];
  const faqLd = faqPageLd(faqs, `${pageUrl}#faq`);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: `${data.tenantName} — ${page.name}`,
        itemListElement: page.facilities.map((f, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'SelfStorage',
            '@id': `${base}${f.publicSlug ? `/${f.publicSlug}` : ''}#local-${f.id}`,
            name: `${data.tenantName} — ${f.name}`,
            ...(f.publicSlug ? { url: `${base}/${f.publicSlug}` } : {}),
            ...localBusinessFields(f, { areaServed: served }),
          },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: data.tenantName, item: base },
          { '@type': 'ListItem', position: 2, name: page.name, item: pageUrl },
        ],
      },
      ...(faqLd ? [faqLd] : []),
    ],
  };
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      <TenantWebChrome
        data={site}
        locale={locale}
        hasBlog={data.hasBlog}
        googleAnalyticsId={data.googleAnalyticsId}
        languageHrefBuilder={(l) => cityPageHref(slug, page.slug, l, data.customDomain)}
      >
        <CityBody
          data={site}
          page={page}
          faqs={faqs}
          others={pages
            .filter((p) => p.slug !== page.slug && p.indexable)
            .map((p) => ({ name: p.name, slug: p.slug, kind: p.kind }))}
          fromPrice={min != null ? formatPrice(min, locale) : null}
          locale={locale}
        />
      </TenantWebChrome>
      <WhatsappFloatButton number={data.whatsappNumber} />
    </NextIntlClientProvider>
  );
}
