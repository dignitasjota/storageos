import {
  ArrowRight,
  BarChart3,
  CalendarCheck,
  Check,
  CreditCard,
  FileSignature,
  Globe,
  KeyRound,
  Map,
  Megaphone,
  ReceiptText,
  ShieldCheck,
  Smartphone,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { Metadata } from 'next';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';


const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.NEXT_PUBLIC_WEB_URL ??
  'https://trasteros.pro'
).replace(/\/$/, '');

const TITLE = 'TrasterOS — Software de gestión para self-storage y trasteros';
const DESCRIPTION =
  'Software todo-en-uno para gestionar tu self-storage: inventario y planos, inquilinos, contratos con firma electrónica, facturación conforme a Veri*Factu, cobros por SEPA, tarjeta y Bizum, control de accesos, CRM y analítica. En español, multi-local y con prueba gratis de 30 días.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  keywords: [
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
  ],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'TrasterOS',
    locale: 'es_ES',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
};

const FEATURES = [
  { key: 'plan', icon: Map },
  { key: 'contracts', icon: FileSignature },
  { key: 'billing', icon: ReceiptText },
  { key: 'payments', icon: CreditCard },
  { key: 'access', icon: KeyRound },
  { key: 'portal', icon: Smartphone },
  { key: 'booking', icon: CalendarCheck },
  { key: 'crm', icon: Megaphone },
  { key: 'whitelabel', icon: Globe },
  { key: 'operations', icon: Wrench },
  { key: 'analytics', icon: BarChart3 },
  { key: 'insurance', icon: ShieldCheck },
] as const;

const EXTRAS = [
  'multiLocal',
  'fiscal',
  'rgpd',
  'reports',
  'ai',
  'reservations',
  'dunning',
  'messaging',
] as const;

export default function LandingPage() {
  const t = useTranslations('landing');

  const badges = t.raw('badges') as string[];
  const steps = t.raw('howItWorks.steps') as { title: string; description: string }[];
  const compliancePoints = t.raw('compliance.points') as string[];
  const seoPoints = t.raw('seoLocal.points') as string[];
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

  // Datos estructurados (schema.org) para SEO / rich results.
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'TrasterOS',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      inLanguage: 'es-ES',
      description: DESCRIPTION,
      featureList: FEATURES.map((f) => t(`features.${f.key}.title`)),
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'EUR',
        description: 'Prueba gratuita de 30 días, sin tarjeta.',
      },
      provider: { '@type': 'Organization', name: 'TrasterOS', url: SITE_URL },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'TrasterOS',
      url: SITE_URL,
      logo: `${SITE_URL}/icon-512.png`,
      description:
        'TrasterOS es un software en la nube para la gestión integral de negocios de self-storage y trasteros en España.',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'TrasterOS',
      url: SITE_URL,
      inLanguage: 'es-ES',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqItems.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
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
      <section className="container pb-16" aria-labelledby="features-title">
        <div className="mb-10 text-center">
          <h2 id="features-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('features.title')}
          </h2>
          <p className="mt-2 text-muted-foreground">{t('features.subtitle')}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card key={key} className="border-border/60">
              <CardHeader>
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <CardTitle className="mt-3 text-lg">{t(`features.${key}.title`)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {t(`features.${key}.description`)}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Cómo funciona */}
      <section className="container pb-16" aria-labelledby="how-title">
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
      <section className="container pb-16" aria-labelledby="compliance-title">
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
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{t('seoLocal.description')}</p>
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
      <section className="container pb-16" aria-labelledby="pricing-title">
        <div className="mb-8 text-center">
          <h2 id="pricing-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('pricing.title')}
          </h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">{t('pricing.subtitle')}</p>
        </div>

        {/* Oferta fundador */}
        <div className="mx-auto mb-8 max-w-3xl rounded-2xl border border-primary/30 bg-primary/5 p-5 text-center">
          <p className="text-sm font-semibold text-primary">🚀 {t('pricing.founderTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('pricing.founderText')}</p>
          <p className="mt-2 text-sm">
            <s className="text-muted-foreground">{t('pricing.setupStrike')}</s>{' '}
            <span className="font-medium">{t('pricing.setupText')}</span>
          </p>
        </div>

        <div className="grid items-start gap-4 md:grid-cols-3">
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
                <Button
                  asChild
                  className="w-full"
                  variant={plan.highlight ? 'default' : 'outline'}
                >
                  <Link href="/register">{plan.cta}</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">{t('pricing.trialNote')}</p>
      </section>

      {/* Preguntas frecuentes */}
      <section className="container pb-20" aria-labelledby="faq-title">
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
