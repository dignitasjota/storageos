'use client';

import { SALES_PORTFOLIO_NO_REP } from '@storageos/shared';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { PageHeader, SalesPage } from '@/components/admin/sales/common';
import { PortfoliosView, type PortfolioFilters } from '@/components/admin/sales/portfolios-view';

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Los filtros que llegan en la dirección (p. ej. desde el aviso de sin primer contacto). */
function initialFrom(params: URLSearchParams): Partial<PortfolioFilters> {
  const out: Partial<PortfolioFilters> = {};
  if (params.get('never') === '1') {
    out.neverContacted = true;
    out.kind = 'prospects';
  }
  const rep = params.get('rep');
  if (rep && (rep === SALES_PORTFOLIO_NO_REP || UUID_RE.test(rep))) out.rep = rep;
  const batch = params.get('batch');
  if (batch) out.batch = batch;
  return out;
}

function PortfoliosPage() {
  const params = useSearchParams();
  return (
    <SalesPage>
      <PageHeader
        title="Carteras"
        description="Todos los prospectos y clientes de los comerciales. Abre uno para ver su ficha y su cronología, dejar una nota al comercial, reasignarlo, editar su ficha o moverlo de fase: consta que lo ha hecho la dirección."
      />
      <PortfoliosView key={params.toString()} initial={initialFrom(params)} />
    </SalesPage>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PortfoliosPage />
    </Suspense>
  );
}
