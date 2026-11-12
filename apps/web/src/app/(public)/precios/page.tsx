import { FEATURE_LABELS, TenantFeatures, type SubscriptionPlanDto } from '@storageos/shared';
import { Check, Minus } from 'lucide-react';

import type { Metadata } from 'next';

import {
  Breadcrumbs,
  CtaBand,
  DemoSection,
  FaqList,
  JsonLd,
  Testimonials,
  breadcrumbLd,
  faqPageLd,
} from '@/components/marketing/blocks';
import { PricingSection } from '@/components/marketing/pricing';
import { StickyMobileCta } from '@/components/marketing/sticky-cta';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { fetchFounderOffer } from '@/lib/founder-offer';
import { SITE_URL } from '@/lib/marketing/site';
import { fetchPublicPlans } from '@/lib/platform-plans';
import { fetchPlatformWebsite } from '@/lib/platform-website';

const TITLE = 'Precios del software de gestión de trasteros | TrasterOS';
const DESCRIPTION =
  'Precios claros para tu negocio de trasteros: plan gratuito para empezar y planes por número de trasteros y locales. Prueba 30 días gratis, sin permanencia.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/precios' },
  openGraph: {
    type: 'website',
    url: `${SITE_URL}/precios`,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'TrasterOS',
    locale: 'es_ES',
  },
};

const CRUMBS = [
  { name: 'Inicio', href: '/' },
  { name: 'Precios', href: '/precios' },
];

const PRICING_FAQ = [
  {
    q: '¿Hay permanencia?',
    a: 'No. Pagas mes a mes (o por año, con descuento) y puedes cambiar de plan o darte de baja cuando quieras.',
  },
  {
    q: '¿Cómo funciona la prueba gratuita?',
    a: 'Tienes 30 días con todas las funciones del plan, sin poner tarjeta. Al terminar, eliges un plan o sigues en el gratuito.',
  },
  {
    q: '¿Qué pasa si supero los trasteros de mi plan?',
    a: 'Te avisamos y puedes subir de plan o añadir un extra de capacidad. Nunca se borra nada de lo que ya tienes.',
  },
  {
    q: '¿Hay cuota de alta o de integración?',
    a: 'No. Puedes importar tus datos tú mismo desde CSV o Excel, y si lo necesitas te ayudamos con la migración.',
  },
  {
    q: '¿Cobráis comisión por los cobros a mis inquilinos?',
    a: 'Con la domiciliación SEPA por remesas y con tu propio TPV de Redsys, no: el dinero va directo a tu cuenta. Si cobras con tarjeta a través de Stripe, se aplica una pequeña comisión por cobro que verás antes de activarlo.',
  },
];

const limit = (n: number | null, noun: string) =>
  n === null ? 'Ilimitados' : `${n.toLocaleString('es-ES')} ${noun}`;

/** Tabla de lo que incluye cada plan (sale del catálogo: panel admin → Planes). */
function PlanComparison({ plans }: { plans: SubscriptionPlanDto[] }) {
  const features = TenantFeatures.filter((f) => plans.some((p) => p.tenantFeatures.includes(f)));
  const rows: { label: string; values: (string | boolean)[] }[] = [
    { label: 'Trasteros', values: plans.map((p) => limit(p.maxUnits, '')) },
    { label: 'Locales', values: plans.map((p) => limit(p.maxFacilities, '')) },
    { label: 'Usuarios del equipo', values: plans.map((p) => limit(p.maxUsers, '')) },
    {
      label: 'Contratos, facturación Veri*Factu, cobros y área de clientes',
      values: plans.map(() => true),
    },
    ...features.map((f) => ({
      label: FEATURE_LABELS[f],
      values: plans.map((p) => p.tenantFeatures.includes(f)),
    })),
  ];
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">Comparativa de los planes de TrasterOS</caption>
        <thead className="bg-muted/50">
          <tr>
            <th scope="col" className="p-3 text-left font-medium">
              Qué incluye
            </th>
            {plans.map((p) => (
              <th key={p.slug} scope="col" className="p-3 text-center font-semibold">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className="p-3 text-left font-normal">
                {row.label}
              </th>
              {row.values.map((v, i) => (
                <td key={plans[i]?.slug ?? i} className="p-3 text-center">
                  {typeof v === 'string' ? (
                    v.trim()
                  ) : v ? (
                    <Check className="mx-auto size-4 text-primary" aria-label="Incluido" />
                  ) : (
                    <Minus
                      className="mx-auto size-4 text-muted-foreground"
                      aria-label="No incluido"
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function PricingPage() {
  const [catalog, offer, { home }] = await Promise.all([
    fetchPublicPlans(),
    fetchFounderOffer(),
    fetchPlatformWebsite(),
  ]);
  const plans = (catalog ?? [])
    .filter((p) => p.isActive && p.isPublic !== false)
    .sort((a, b) => a.priceMonthly - b.priceMonthly);

  return (
    <>
      <PlatformAttribution />
      <JsonLd graph={[breadcrumbLd(CRUMBS), faqPageLd(PRICING_FAQ, `${SITE_URL}/precios`)]} />
      <section className="container py-12 md:py-16">
        <Breadcrumbs items={CRUMBS} />
        <div className="mx-auto mt-6 max-w-3xl text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-5xl">
            Precios del software de gestión de trasteros
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Sin cuota de alta ni permanencia. Empieza gratis y paga según los trasteros que
            gestionas.
          </p>
        </div>
        {offer && (
          <div className="mx-auto mt-8 max-w-3xl rounded-2xl border border-primary/30 bg-primary/5 p-5 text-center">
            <p className="text-sm font-semibold text-primary">🚀 {offer.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{offer.text}</p>
          </div>
        )}
        <div className="mt-10">
          <PricingSection />
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Prueba 30 días gratis, sin tarjeta. Te ayudamos a importar tus datos.
        </p>
      </section>

      {plans.length > 1 && (
        <section className="container pb-12" aria-labelledby="compare-title">
          <h2 id="compare-title" className="mb-6 text-2xl font-semibold tracking-tight">
            Compara los planes
          </h2>
          <PlanComparison plans={plans} />
        </section>
      )}

      <Testimonials items={home.testimonials ?? []} />

      <section className="container py-12" aria-labelledby="pricing-faq-title">
        <div className="mx-auto max-w-3xl">
          <h2
            id="pricing-faq-title"
            className="mb-6 text-center text-2xl font-semibold tracking-tight"
          >
            Preguntas sobre los precios
          </h2>
          <FaqList items={PRICING_FAQ} />
        </div>
      </section>

      <DemoSection place="precios" />
      <CtaBand />
      <StickyMobileCta />
    </>
  );
}
