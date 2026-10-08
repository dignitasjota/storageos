import { ArrowRight, Check, Home, Users, Warehouse } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { Metadata } from 'next';

import { PlatformContactForm } from '@/components/public/platform-contact-form';
import { FEATURE_ICONS, type FeatureKey } from '@/components/public/site-nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchFounderOffer } from '@/lib/founder-offer';
import { safeJsonLd } from '@/lib/json-ld';
import { fetchPlatformWebsite } from '@/lib/platform-website';

const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.NEXT_PUBLIC_WEB_URL ??
  'https://trasteros.pro'
).replace(/\/$/, '');

const TITLE = 'TrasterOS — Software de gestión para self-storage y trasteros';
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

export default function LandingPage() {
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
  const faqItems = t.raw('faq.items') as { q: string; a: string }[];
  const plans = t.raw('pricing.plans') as {
    name: string;
    price: string;
    yearly?: number;
    tagline: string;
    cta: string;
    highlight?: boolean;
    features: string[];
  }[];

  return (
    <>
      <PlatformJsonLd
        features={FEATURES.map((f) => t(`features.${f.key}.title`))}
        faq={faqItems}
        prices={plans.map((p) =>
          Number.parseFloat(p.price.replace(/[^\d.,]/g, '').replace(',', '.')),
        )}
      />

      {/* Hero */}
      <section className="container flex flex-col items-center gap-6 py-20 text-center md:py-28">
        <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-5xl">
          {t('heroTitle')}
        </h1>
        <p className="max-w-2xl text-pretty text-lg text-muted-foreground">{t('heroSubtitle')}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/register">
              {t('primaryCta')}
              <ArrowRight className="ml-2 size-4" aria-hidden />
            </Link>
          </Button>
          <Button asChild size="lg" variant="ghost">
            <Link href="/login">{t('secondaryCta')}</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t('heroNote')}</p>
        <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {badges.map((badge) => (
            <li key={badge} className="flex items-center gap-1.5">
              <Check className="size-4 shrink-0 text-primary" aria-hidden />
              <span>{badge}</span>
            </li>
          ))}
        </ul>
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
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card
              key={key}
              id={`func-${key}`}
              className="group scroll-mt-24 border-border/60 transition-colors duration-200 hover:border-primary hover:bg-primary hover:shadow-lg"
            >
              <CardHeader>
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors duration-200 group-hover:bg-white/15 group-hover:text-primary-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <CardTitle className="mt-3 text-lg transition-colors duration-200 group-hover:text-primary-foreground">
                  {t(`features.${key}.title`)}
                </CardTitle>
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
                  <CardTitle className="mt-3 text-lg">{a.title}</CardTitle>
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
                    <Link href="#precios">{a.cta}</Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

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

        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => (
            <Card
              key={plan.name}
              className={plan.highlight ? 'relative border-primary shadow-lg' : 'border-border/60'}
            >
              {plan.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
                  {t('pricing.mostPopular')}
                </span>
              )}
              <CardHeader>
                <CardTitle className="text-lg">{plan.name}</CardTitle>
                <p className="text-sm text-muted-foreground">{plan.tagline}</p>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold tracking-tight">{plan.price}</span>
                  {plan.price !== '0€' && (
                    <span className="text-sm text-muted-foreground">{t('pricing.perMonth')}</span>
                  )}
                </div>
                {plan.yearly && (
                  <p className="text-xs text-muted-foreground">
                    {t('pricing.yearlyLabel', { yearly: plan.yearly })} · {t('pricing.ivaNote')}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild className="w-full" variant={plan.highlight ? 'default' : 'outline'}>
                  <Link href="/register">{plan.cta}</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">{t('pricing.trialNote')}</p>
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
          <dl className="divide-y divide-border rounded-2xl border">
            {faqItems.map((item) => (
              <div key={item.q} className="p-6">
                <dt className="font-semibold">{item.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <ContactSection />

      {/* CTA final */}
      <section className="container pb-24 text-center">
        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{t('cta.title')}</h2>
        <p className="mx-auto mt-2 max-w-xl text-muted-foreground">{t('cta.subtitle')}</p>
        <Button asChild size="lg" className="mt-6">
          <Link href="/register">
            {t('primaryCta')}
            <ArrowRight className="ml-2 size-4" aria-hidden />
          </Link>
        </Button>
      </section>
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
  prices,
}: {
  features: string[];
  faq: { q: string; a: string }[];
  prices: number[];
}) {
  const { seo, footer } = await fetchPlatformWebsite();
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
