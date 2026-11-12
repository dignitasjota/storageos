import { ArrowRight, Calculator, Check, Home, Users, Warehouse } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { PlatformHomeTextsInput, PublicPlatformBlogPostSummaryDto } from '@storageos/shared';
import type { Metadata } from 'next';

import {
  CtaBand,
  CtaButtons,
  DemoSection,
  FaqList,
  ProductShot,
  Testimonials,
} from '@/components/marketing/blocks';
import { PricingSection } from '@/components/marketing/pricing';
import { StickyMobileCta } from '@/components/marketing/sticky-cta';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { PlatformContactForm } from '@/components/public/platform-contact-form';
import {
  AUDIENCE_PAGE_SLUG,
  FEATURE_ICONS,
  FEATURE_PAGE_SLUG,
  type FeatureKey,
} from '@/components/public/site-nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { fetchFounderOffer } from '@/lib/founder-offer';
import { safeJsonLd } from '@/lib/json-ld';
import { fetchPlatformBlogPosts, formatBlogDate } from '@/lib/marketing/blog';
import { fetchPublicPlans, mergeLandingPlans, type LandingPlanCopy } from '@/lib/platform-plans';
import { fetchPlatformWebsite } from '@/lib/platform-website';

const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.NEXT_PUBLIC_WEB_URL ??
  'https://trasteros.pro'
).replace(/\/$/, '');

const TITLE = 'Software de gestión de trasteros y self-storage | TrasterOS';
/** Descripción por defecto (≈155 caracteres: lo que Google muestra sin cortar). */
const DESCRIPTION =
  'Gestiona tu self-storage en la nube: contratos con firma electrónica, facturación Veri*Factu, cobros por SEPA y Bizum, accesos y CRM. Prueba gratis 30 días.';
/** Descripción larga para los datos estructurados. */
const LONG_DESCRIPTION =
  'Software todo-en-uno para gestionar tu self-storage: inventario y planos, inquilinos, contratos con firma electrónica, facturación conforme a Veri*Factu, cobros por SEPA, tarjeta y Bizum, control de accesos, CRM y analítica. En español, multi-local y con prueba gratis de 30 días.';

const KEYWORDS = [
  'software self-storage',
  'software para trasteros',
  'programa de gestión de trasteros',
  'software gestión self-storage',
  'software guardamuebles',
  'gestión de trasteros',
  'facturación Veri*Factu trasteros',
  'control de accesos trastero',
  'alquiler de trasteros software',
  'CRM self-storage España',
  'software administrador de cartera de alquileres',
  'gestión de alquiler de viviendas',
  'liquidación a propietarios',
];

/** Título, descripción, verificaciones e indexación: panel admin → Web de TrasterOS → SEO. */
export async function generateMetadata(): Promise<Metadata> {
  const { seo } = await fetchPlatformWebsite();
  const title = seo.title || TITLE;
  const description = seo.description || DESCRIPTION;
  const verification: Metadata['verification'] = {
    ...(seo.googleVerification ? { google: seo.googleVerification } : {}),
    ...(seo.bingVerification ? { other: { 'msvalidate.01': seo.bingVerification } } : {}),
  };
  return {
    title: { absolute: title },
    description,
    keywords: KEYWORDS,
    alternates: { canonical: '/' },
    ...(seo.indexable ? {} : { robots: { index: false, follow: false } }),
    verification,
    openGraph: {
      type: 'website',
      url: SITE_URL,
      title,
      description,
      siteName: 'TrasterOS',
      locale: 'es_ES',
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

const FEATURES = (Object.keys(FEATURE_ICONS) as FeatureKey[]).map((key) => ({
  key,
  icon: FEATURE_ICONS[key],
}));

const AUDIENCE_ICONS: Record<string, typeof Warehouse> = {
  operators: Warehouse,
  managers: Users,
  housing: Home,
};

const EXTRAS = [
  'multiLocal',
  'fiscal',
  'rgpd',
  'reports',
  'ai',
  'reservations',
  'dunning',
  'messaging',
  'returns',
  'waitlist',
  'deposits',
] as const;

export default async function LandingPage() {
  const [{ home }, posts] = await Promise.all([fetchPlatformWebsite(), fetchPlatformBlogPosts()]);
  return <LandingContent home={home} posts={posts.slice(0, 3)} />;
}

/** Los textos propios de la portada (panel admin) mandan sobre los de serie. */
function LandingContent({
  home,
  posts,
}: {
  home: PlatformHomeTextsInput;
  posts: PublicPlatformBlogPostSummaryDto[];
}) {
  const t = useTranslations('landing');

  const badges = t.raw('badges') as string[];
  const steps = t.raw('howItWorks.steps') as { title: string; description: string }[];
  const compliancePoints = t.raw('compliance.points') as string[];
  const seoPoints = t.raw('seoLocal.points') as string[];
  const audiences = t.raw('audiences.items') as {
    key: string;
    title: string;
    badge?: string;
    description: string;
    points: string[];
    cta: string;
  }[];
  const faqItems = home.faq?.length ? home.faq : (t.raw('faq.items') as { q: string; a: string }[]);
  const plans = t.raw('pricing.plans') as LandingPlanCopy[];

  return (
    <>
      <PlatformAttribution />
      <PlatformJsonLd
        features={FEATURES.map((f) => t(`features.${f.key}.title`))}
        faq={faqItems}
        plans={plans}
      />

      {/* Hero */}
      <section className="container flex flex-col items-center gap-6 pb-12 pt-16 text-center md:pt-24">
        <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-5xl">
          {home.heroTitle ?? t('heroTitle')}
        </h1>
        <p className="max-w-2xl text-pretty text-lg text-muted-foreground">
          {home.heroSubtitle ?? t('heroSubtitle')}
        </p>
        <CtaButtons center />
        <p className="text-sm text-muted-foreground">{home.heroNote ?? t('heroNote')}</p>
        <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {badges.map((badge) => (
            <li key={badge} className="flex items-center gap-1.5">
              <Check className="size-4 shrink-0 text-primary" aria-hidden />
              <span>{badge}</span>
            </li>
          ))}
        </ul>
        <ProductShot shot="dashboard" priority className="mt-8 w-full max-w-5xl" />
      </section>

      {/* Funcionalidades */}
      <section
        id="funcionalidades"
        className="container scroll-mt-20 pb-16"
        aria-labelledby="features-title"
      >
        <div className="mb-10 text-center">
          <h2 id="features-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('features.title')}
          </h2>
          <p className="mt-2 text-muted-foreground">{t('features.subtitle')}</p>
          <Link
            href="/funcionalidades"
            className="mt-3 inline-flex items-center text-sm font-medium text-primary hover:underline"
          >
            Ver todas las funcionalidades
            <ArrowRight className="ml-1 size-4" aria-hidden />
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card
              key={key}
              id={`func-${key}`}
              className="group relative scroll-mt-24 border-border/60 transition-colors duration-200 hover:border-primary hover:bg-primary hover:shadow-lg"
            >
              <CardHeader>
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors duration-200 group-hover:bg-white/15 group-hover:text-primary-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="mt-3 text-lg font-semibold leading-none tracking-tight transition-colors duration-200 group-hover:text-primary-foreground">
                  {FEATURE_PAGE_SLUG[key] ? (
                    <Link
                      href={`/funcionalidades/${FEATURE_PAGE_SLUG[key]}`}
                      className="after:absolute after:inset-0"
                    >
                      {t(`features.${key}.title`)}
                    </Link>
                  ) : (
                    t(`features.${key}.title`)
                  )}
                </h3>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground transition-colors duration-200 group-hover:text-primary-foreground/85">
                {t(`features.${key}.description`)}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Para quién */}
      <section
        id="para-quien"
        className="container scroll-mt-20 pb-16"
        aria-labelledby="audiences-title"
      >
        <div className="mb-10 text-center">
          <h2 id="audiences-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('audiences.title')}
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">{t('audiences.subtitle')}</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {audiences.map((a) => {
            const Icon = AUDIENCE_ICONS[a.key] ?? Warehouse;
            return (
              <Card
                key={a.key}
                id={
                  a.key === 'managers'
                    ? 'administradores'
                    : a.key === 'housing'
                      ? 'viviendas'
                      : undefined
                }
                className={`flex scroll-mt-20 flex-col ${a.key === 'managers' ? 'border-primary shadow-lg' : 'border-border/60'}`}
              >
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    {a.badge && (
                      <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                        {a.badge}
                      </span>
                    )}
                  </div>
                  <h3 className="mt-3 text-lg font-semibold leading-none tracking-tight">
                    {a.title}
                  </h3>
                  <p className="text-sm text-muted-foreground">{a.description}</p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-between gap-4">
                  <ul className="space-y-2 text-sm">
                    {a.points.map((point) => (
                      <li key={point} className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                  <Button asChild variant={a.key === 'managers' ? 'default' : 'outline'}>
                    <Link
                      href={`/soluciones/${AUDIENCE_PAGE_SLUG[a.key] ?? 'operadores-self-storage'}`}
                    >
                      {a.cta}
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <Testimonials items={home.testimonials ?? []} />

      {/* Cómo funciona */}
      <section
        id="como-funciona"
        className="container scroll-mt-20 pb-16"
        aria-labelledby="how-title"
      >
        <div className="mb-10 text-center">
          <h2 id="how-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('howItWorks.title')}
          </h2>
          <p className="mt-2 text-muted-foreground">{t('howItWorks.subtitle')}</p>
        </div>
        <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, i) => (
            <li key={step.title} className="rounded-xl border bg-card p-6">
              <span className="flex size-9 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <h3 className="mt-4 font-semibold">{step.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Cumplimiento fiscal */}
      <section
        id="cumplimiento"
        className="container scroll-mt-20 pb-16"
        aria-labelledby="compliance-title"
      >
        <div className="rounded-2xl border bg-primary/5 p-8 md:p-10">
          <h2 id="compliance-title" className="text-xl font-semibold tracking-tight md:text-2xl">
            {t('compliance.title')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('compliance.description')}</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {compliancePoints.map((point) => (
              <li key={point} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* SEO local / captación */}
      <section className="container pb-16" aria-labelledby="seo-title">
        <div className="rounded-2xl border bg-muted/30 p-8 md:p-10">
          <h2 id="seo-title" className="text-xl font-semibold tracking-tight md:text-2xl">
            {t('seoLocal.title')}
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            {t('seoLocal.description')}
          </p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {seoPoints.map((point) => (
              <li key={point} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Extras */}
      <section className="container pb-16" aria-labelledby="extras-title">
        <div className="rounded-2xl border bg-muted/30 p-8 md:p-10">
          <h2 id="extras-title" className="text-xl font-semibold tracking-tight md:text-2xl">
            {t('extras.title')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('extras.subtitle')}</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {EXTRAS.map((key) => (
              <li key={key} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>{t(`extras.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Precios */}
      <section
        id="precios"
        className="container scroll-mt-20 pb-16"
        aria-labelledby="pricing-title"
      >
        <div className="mb-8 text-center">
          <h2 id="pricing-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('pricing.title')}
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">{t('pricing.subtitle')}</p>
        </div>

        {/* Oferta fundador (panel admin → Web de TrasterOS; oculta si está desactivada) */}
        <FounderOffer />

        <PricingSection />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t('pricing.trialNote')}{' '}
          <Link href="/precios" className="font-medium text-primary hover:underline">
            Compara los planes →
          </Link>
        </p>
      </section>

      <DemoSection place="portada" />

      {/* Calculadora y guías */}
      <section className="container pb-16" aria-labelledby="resources-title">
        <h2 id="resources-title" className="sr-only">
          Recursos para tu negocio de trasteros
        </h2>
        <div className={`grid gap-4 ${posts.length > 0 ? 'lg:grid-cols-[1fr_2fr]' : ''}`}>
          <Link
            href="/calculadora-rentabilidad-trasteros"
            className="group flex flex-col justify-between rounded-2xl border bg-primary/5 p-6 transition-colors hover:border-primary"
          >
            <div>
              <Calculator className="size-6 text-primary" aria-hidden />
              <p className="mt-3 text-lg font-semibold">Calculadora de rentabilidad de trasteros</p>
              <p className="mt-1 text-sm text-muted-foreground">
                ¿Cuánto puede darte tu local? Ingresos, beneficio y en cuánto recuperas la
                inversión.
              </p>
            </div>
            <span className="mt-4 inline-flex items-center text-sm font-medium text-primary">
              Calcular ahora
              <ArrowRight
                className="ml-1 size-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </span>
          </Link>
          {posts.length > 0 && (
            <div className="rounded-2xl border p-6">
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-lg font-semibold">Guías para tu negocio</p>
                <Link href="/blog" className="text-sm font-medium text-primary hover:underline">
                  Ver el blog
                </Link>
              </div>
              <ul className="mt-4 divide-y">
                {posts.map((p) => (
                  <li key={p.slug} className="py-3">
                    <Link href={`/blog/${p.slug}`} className="font-medium hover:text-primary">
                      {p.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatBlogDate(p.publishedAt)} · {p.readingMinutes} min de lectura
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* Preguntas frecuentes */}
      <section id="faq" className="container scroll-mt-20 pb-20" aria-labelledby="faq-title">
        <div className="mx-auto max-w-3xl">
          <div className="mb-8 text-center">
            <h2 id="faq-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
              {t('faq.title')}
            </h2>
            <p className="mt-2 text-muted-foreground">{t('faq.subtitle')}</p>
          </div>
          <FaqList items={faqItems} />
        </div>
      </section>

      <ContactSection />

      <CtaBand title={t('cta.title')} subtitle={t('cta.subtitle')} />
      <StickyMobileCta />
    </>
  );
}

/** Formulario de contacto (panel admin → Web de TrasterOS). */
async function ContactSection() {
  const { contactForm } = await fetchPlatformWebsite();
  if (!contactForm) return null;
  return (
    <section id="contacto" className="container scroll-mt-20 pb-20" aria-labelledby="contact-title">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <h2 id="contact-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {contactForm.title}
          </h2>
          {contactForm.subtitle && (
            <p className="mt-2 text-muted-foreground">{contactForm.subtitle}</p>
          )}
        </div>
        <PlatformContactForm config={contactForm} />
      </div>
    </section>
  );
}

async function FounderOffer() {
  const offer = await fetchFounderOffer();
  if (!offer) return null;
  return (
    <div className="mx-auto mb-8 max-w-3xl rounded-2xl border border-primary/30 bg-primary/5 p-5 text-center">
      <p className="text-sm font-semibold text-primary">🚀 {offer.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{offer.text}</p>
      {(offer.setupStrike || offer.setupText) && (
        <p className="mt-2 text-sm">
          {offer.setupStrike && <s className="text-muted-foreground">{offer.setupStrike}</s>}{' '}
          {offer.setupText && <span className="font-medium">{offer.setupText}</span>}
        </p>
      )}
    </div>
  );
}

/**
 * Datos estructurados (schema.org) para los resultados enriquecidos de Google:
 * la aplicación con sus precios, la empresa (con su contacto y redes del pie de
 * la web) y las preguntas frecuentes.
 */
async function PlatformJsonLd({
  features,
  faq,
  plans,
}: {
  features: string[];
  faq: { q: string; a: string }[];
  plans: LandingPlanCopy[];
}) {
  const [{ seo, footer }, catalog] = await Promise.all([
    fetchPlatformWebsite(),
    fetchPublicPlans(),
  ]);
  const prices = mergeLandingPlans(plans, catalog).map((p) => p.priceValue);
  const orgName = seo.organizationName || 'TrasterOS';
  const sameAs = Object.values(footer.social).filter((u) => u);
  const valid = prices.filter((p) => Number.isFinite(p));
  const organization = {
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: orgName,
    url: SITE_URL,
    logo: `${SITE_URL}/icon-512.png`,
    description:
      'TrasterOS es un software en la nube para la gestión integral de negocios de self-storage, trasteros y alquileres en España.',
    ...(sameAs.length ? { sameAs } : {}),
    ...(footer.email || footer.phone
      ? {
          contactPoint: {
            '@type': 'ContactPoint',
            contactType: 'customer support',
            areaServed: 'ES',
            availableLanguage: ['es'],
            ...(footer.email ? { email: footer.email } : {}),
            ...(footer.phone ? { telephone: footer.phone } : {}),
          },
        }
      : {}),
    ...(footer.address
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: footer.address,
            addressCountry: 'ES',
          },
        }
      : {}),
  };
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      organization,
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: 'TrasterOS',
        url: SITE_URL,
        inLanguage: 'es-ES',
        publisher: { '@id': `${SITE_URL}/#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#software`,
        name: 'TrasterOS',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        url: SITE_URL,
        inLanguage: 'es-ES',
        description: LONG_DESCRIPTION,
        featureList: features,
        publisher: { '@id': `${SITE_URL}/#organization` },
        offers:
          valid.length > 0
            ? {
                '@type': 'AggregateOffer',
                priceCurrency: 'EUR',
                lowPrice: Math.min(...valid),
                highPrice: Math.max(...valid),
                offerCount: valid.length,
                description: 'Precio mensual por plan. Prueba gratuita de 30 días, sin tarjeta.',
              }
            : { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
  );
}
