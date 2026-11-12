import type { Metadata } from 'next';

import {
  Breadcrumbs,
  CtaBand,
  DemoSection,
  JsonLd,
  breadcrumbLd,
} from '@/components/marketing/blocks';
import { MarketingPageGrid } from '@/components/marketing/marketing-page';
import { StickyMobileCta } from '@/components/marketing/sticky-cta';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { FEATURE_PAGES } from '@/lib/marketing/pages';

const TITLE = 'Funcionalidades del software de gestión de trasteros | TrasterOS';
const DESCRIPTION =
  'Facturación Veri*Factu, cobros por SEPA, tarjeta y Bizum, control de accesos, reserva online, contratos con firma, impagos, web y área de clientes.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/funcionalidades' },
  openGraph: {
    type: 'website',
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'TrasterOS',
    locale: 'es_ES',
  },
};

const CRUMBS = [
  { name: 'Inicio', href: '/' },
  { name: 'Funcionalidades', href: '/funcionalidades' },
];

export default function FeaturesIndexPage() {
  return (
    <>
      <PlatformAttribution />
      <JsonLd graph={[breadcrumbLd(CRUMBS)]} />
      <section className="container py-12 md:py-16">
        <Breadcrumbs items={CRUMBS} />
        <div className="mx-auto mt-6 max-w-3xl text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-5xl">
            Funcionalidades del software de gestión de trasteros
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Todo lo que necesita un negocio de self-storage, de la reserva al cobro, en un solo
            programa en la nube.
          </p>
        </div>
        <div className="mt-10">
          <MarketingPageGrid pages={FEATURE_PAGES} />
        </div>
      </section>
      <DemoSection place="funcionalidades" />
      <CtaBand />
      <StickyMobileCta />
    </>
  );
}
