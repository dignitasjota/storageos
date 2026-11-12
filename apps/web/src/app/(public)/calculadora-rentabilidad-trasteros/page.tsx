import Link from 'next/link';

import type { Metadata } from 'next';

import {
  Breadcrumbs,
  CtaBand,
  DemoSection,
  FaqList,
  JsonLd,
  breadcrumbLd,
  faqPageLd,
} from '@/components/marketing/blocks';
import { ProfitabilityCalculator } from '@/components/marketing/profitability-calculator';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { ORGANIZATION_ID, SITE_URL } from '@/lib/marketing/site';

const PATH = '/calculadora-rentabilidad-trasteros';
const TITLE = 'Calculadora de rentabilidad de un negocio de trasteros | TrasterOS';
const DESCRIPTION =
  'Calcula gratis cuánto puede darte un local de trasteros: ingresos, gastos, beneficio, ocupación para cubrir gastos y meses para recuperar la inversión.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    type: 'website',
    url: `${SITE_URL}${PATH}`,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'TrasterOS',
    locale: 'es_ES',
  },
};

const CRUMBS = [
  { name: 'Inicio', href: '/' },
  { name: 'Calculadora de rentabilidad', href: PATH },
];

const FAQ = [
  {
    q: '¿Qué ocupación es normal en un negocio de trasteros?',
    a: 'Depende de la zona y de la antigüedad del local: los primeros meses la ocupación crece poco a poco y un centro consolidado suele moverse en ocupaciones altas. Lo importante es saber con qué ocupación cubres gastos: eso te dice cuánto margen tienes.',
  },
  {
    q: '¿El precio va con IVA o sin IVA?',
    a: 'Pon el precio sin IVA: es lo que realmente ingresas. El alquiler de trasteros lleva un 21 % de IVA que cobras al cliente y declaras a Hacienda.',
  },
  {
    q: '¿Qué gastos debo incluir?',
    a: 'Alquiler o hipoteca del local, luz, agua, internet, alarma y vigilancia, limpieza y personal, seguros, mantenimiento, software y comisiones de cobro. No incluye impuestos sobre el beneficio ni amortizaciones.',
  },
  {
    q: '¿Cómo mejoro la rentabilidad?',
    a: 'Llenando antes los trasteros vacíos (web, reserva online y reseñas), ajustando los precios según la ocupación de cada tamaño y reduciendo los impagos con cobros automáticos.',
  },
];

export default function ProfitabilityCalculatorPage() {
  return (
    <>
      <PlatformAttribution />
      <JsonLd
        graph={[
          breadcrumbLd(CRUMBS),
          {
            '@type': 'WebApplication',
            '@id': `${SITE_URL}${PATH}#calculadora`,
            name: 'Calculadora de rentabilidad de trasteros',
            url: `${SITE_URL}${PATH}`,
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            inLanguage: 'es-ES',
            isAccessibleForFree: true,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
            publisher: { '@id': ORGANIZATION_ID },
          },
          faqPageLd(FAQ, `${SITE_URL}${PATH}`),
        ]}
      />
      <section className="container py-12 md:py-16">
        <Breadcrumbs items={CRUMBS} />
        <div className="mx-auto mt-6 max-w-3xl text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-5xl">
            Calculadora de rentabilidad de un negocio de trasteros
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Pon los datos de tu local (o del que quieres abrir) y mira al momento los ingresos, el
            beneficio y con qué ocupación cubres gastos.
          </p>
        </div>
        <div className="mt-10">
          <ProfitabilityCalculator />
        </div>
      </section>

      <section className="container max-w-3xl pb-12">
        <h2 className="text-2xl font-semibold tracking-tight">Cómo se calcula</h2>
        <div className="mt-4 space-y-3 leading-relaxed text-muted-foreground">
          <p>
            Los <strong className="text-foreground">ingresos</strong> son los trasteros alquilados
            (el total por la ocupación) por el precio medio. Los{' '}
            <strong className="text-foreground">gastos</strong> son la suma de los costes fijos del
            mes, y el <strong className="text-foreground">beneficio</strong>, la diferencia.
          </p>
          <p>
            La ocupación para cubrir gastos te dice cuántos trasteros necesitas tener alquilados
            para no perder dinero; por encima de ella, cada trastero que alquilas es beneficio. Si
            pones la inversión inicial, verás en cuántos meses la recuperas con el beneficio de ese
            momento.
          </p>
          <p>
            ¿Estás empezando? En nuestro{' '}
            <Link href="/blog" className="text-primary underline">
              blog
            </Link>{' '}
            tienes guías para montar y gestionar un negocio de trasteros.
          </p>
        </div>
      </section>

      <section className="container max-w-3xl pb-12" aria-labelledby="calc-faq">
        <h2 id="calc-faq" className="mb-6 text-2xl font-semibold tracking-tight">
          Preguntas frecuentes
        </h2>
        <FaqList items={FAQ} />
      </section>

      <DemoSection place="calculadora" />
      <CtaBand title="Llena tus trasteros y cóbralos sin perseguir a nadie" />
    </>
  );
}
