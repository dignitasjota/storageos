'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import {
  Empty,
  PageHeader,
  QueryError,
  relativeDays,
  SalesPage,
} from '@/components/admin/sales/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSalesClients, useSalesOpportunities } from '@/lib/admin/sales-hooks';
import { formatEur } from '@/lib/format';

export default function SalesOpportunitiesPage() {
  const opps = useSalesOpportunities();
  const clients = useSalesClients();
  const leadOf = useMemo(
    () => new Map((clients.data ?? []).map((c) => [c.tenantId, c.leadId])),
    [clients.data],
  );
  const rows = opps.data ?? [];

  return (
    <SalesPage>
      <PageHeader
        title="Qué ofrecer"
        description="Extras que les vendrían bien a tus clientes: los han intentado usar o les hacen falta por cómo trabajan."
      />
      {opps.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : opps.isError ? (
        <QueryError query={opps} />
      ) : rows.length === 0 ? (
        <Empty>Ahora mismo no hay nada que ofrecer a tus clientes.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((o) => (
            <Card key={o.addonId}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{o.addonName}</CardTitle>
                <CardDescription>{formatEur(o.priceMonthly)} al mes</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {o.candidates.map((c) => {
                    const leadId = leadOf.get(c.tenantId);
                    return (
                      <li
                        key={c.tenantId}
                        className="flex items-start justify-between gap-2 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="font-medium">{c.tenantName}</p>
                          {c.reasons.length > 0 && (
                            <p className="text-xs text-muted-foreground">{c.reasons.join(' · ')}</p>
                          )}
                          {c.lastOfferAt && (
                            <p className="text-xs text-muted-foreground">
                              Ya se le ofreció {relativeDays(c.lastOfferAt)}
                            </p>
                          )}
                        </div>
                        {leadId && (
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/admin/sales/accounts/${leadId}`}>Abrir</Link>
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </SalesPage>
  );
}
