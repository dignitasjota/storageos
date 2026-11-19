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
  'Precios claros para tu negocio de trasteros: desde 1 € por trastero al mes (mínimo 19 €) y planes por número de trasteros y locales. Prueba 30 días gratis, sin tarjeta ni permanencia.';

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
    a: 'No. Pagas mes a mes (o por año, con descuento, salvo en Basic) y puedes cambiar de plan o darte de baja cuando quieras.',
  },
  {
    q: '¿Cómo funciona el plan Basic?',
    a: 'Pagas 1 € al mes por cada trastero, con un mínimo de 19 €. Contamos los trasteros que tienes unos días antes de cada cobro, sin prorrateos. Llega hasta 50 trasteros, 1 local y 1 usuario. Si más adelante necesitas otro usuario, lo añades como extra desde Configuración → Suscripción (10 € al mes).',
  },
  {
    q: '¿Cómo funciona la prueba gratuita?',
    a: 'Eliges el plan al registrarte y lo pruebas 30 días con sus funciones y sus límites, sin poner tarjeta. Al terminar, eliges cómo pagar; si no, tu cuenta queda en solo lectura: no se pierde nada y vuelve a funcionar en cuanto pagas.',
  },
  {
    q: '¿Qué pasa si supero los trasteros de mi plan?',
    a: 'No puedes dar de alta más hasta subir de plan; nunca se borra nada de lo que ya tienes. En Pro (hasta 1.000 trasteros) y Administrador (hasta 1.500) te contactamos para darte un precio a medida.',
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

// Con punto de miles también en 4 cifras («1.000»).
const limit = (n: number | null, noun: string) =>
  n === null ? 'Ilimitados' : `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ${noun}`;

const eur = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2 })} €`;

/** Precio de cada plan en la comparativa («1 € por trastero, mínimo 19 €» en Basic). */
const planPrice = (p: SubscriptionPlanDto) =>
  (p.includedUnits != null && p.extraUnitPrice != null
    ? `${eur(p.extraUnitPrice)} por trastero (mínimo ${eur(p.priceMonthly)})`
    : `${eur(p.priceMonthly)} al mes`) + (p.pricesIncludeVat === false ? ' + IVA' : ', IVA incl.');

/** Tabla de lo que incluye cada plan (sale del catálogo: panel admin → Planes). */
function PlanComparison({ plans }: { plans: SubscriptionPlanDto[] }) {
  const features = TenantFeatures.filter((f) => plans.some((p) => p.tenantFeatures.includes(f)));
  const rows: { label: string; values: (string | boolean)[] }[] = [
    { label: 'Precio', values: plans.map((p) => planPrice(p)) },
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
            Sin cuota de alta ni permanencia. Desde 1 € por trastero al mes: pruébalo 30 días gratis
            y elige el plan que encaja con tu negocio.
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
