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
import { SOLUTION_PAGES } from '@/lib/marketing/pages';

const TITLE = 'Software de trasteros para operadores y administradores | TrasterOS';
const DESCRIPTION =
  'TrasterOS para operadores de self-storage, administradores de trasteros de varios propietarios y negocios que alquilan trasteros y viviendas.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/soluciones' },
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
  { name: 'Soluciones', href: '/soluciones' },
];

export default function SolutionsIndexPage() {
  return (
    <>
      <PlatformAttribution />
      <JsonLd graph={[breadcrumbLd(CRUMBS)]} />
      <section className="container py-12 md:py-16">
        <Breadcrumbs items={CRUMBS} />
        <div className="mx-auto mt-6 max-w-3xl text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-5xl">
            Un programa para cada forma de gestionar trasteros
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Tus propios locales, los de tus clientes o trasteros y viviendas en la misma cuenta.
          </p>
        </div>
        <div className="mt-10">
          <MarketingPageGrid pages={SOLUTION_PAGES} />
        </div>
      </section>
      <DemoSection place="soluciones" />
      <CtaBand />
      <StickyMobileCta />
    </>
  );
}
