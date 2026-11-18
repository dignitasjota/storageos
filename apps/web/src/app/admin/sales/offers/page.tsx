'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import {
  Empty,
  PageHeader,
  QueryError,
  relativeDays,
  SalesPage,
  Stat,
} from '@/components/admin/sales/common';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSalesOffers } from '@/lib/admin/sales-hooks';
import { formatDate, formatEur } from '@/lib/format';

export default function SalesOffersPage() {
  const offers = useSalesOffers();
  const rows = offers.data ?? [];
  const sent = rows.filter((o) => o.status === 'sent' && !o.expired);
  const opened = sent.filter((o) => o.openedAt);
  const accepted = rows.filter((o) => o.status === 'accepted');

  return (
    <SalesPage>
      <PageHeader
        title="Propuestas"
        description="Las que has enviado: cuándo las abrieron y cuáles han aceptado. Valen 15 días."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Esperando respuesta" value={sent.length} />
        <Stat label="Abiertas" value={opened.length} hint="De las que esperan" />
        <Stat label="Aceptadas" value={accepted.length} tone="good" />
        <Stat
          label="Conversión"
          value={rows.length ? `${Math.round((accepted.length / rows.length) * 100)} %` : '—'}
        />
      </div>
      {offers.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : offers.isError ? (
        <QueryError query={offers} />
      ) : rows.length === 0 ? (
        <Empty>Aún no has enviado propuestas. Se envían desde la ficha de cada cuenta.</Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuenta</TableHead>
                <TableHead>Propuesta</TableHead>
                <TableHead className="hidden md:table-cell">Enviada</TableHead>
                <TableHead className="hidden md:table-cell">Abierta</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => {
                const name = o.tenantName ?? o.leadName ?? '—';
                return (
                  <TableRow key={o.id}>
                    <TableCell>
                      {o.leadId ? (
                        <Link
                          href={`/admin/sales/accounts/${o.leadId}`}
                          className="font-medium hover:underline"
                        >
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {o.planName} · {formatEur(o.total)}{' '}
                      {o.cycle === 'yearly' ? 'al año' : 'al mes'}
                      {o.couponCode && (
                        <span className="block text-xs text-muted-foreground">
                          Cupón {o.couponCode}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">
                      {formatDate(o.createdAt)}
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">
                      {o.openedAt ? (
                        relativeDays(o.openedAt)
                      ) : (
                        <span className="text-muted-foreground">No</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={o.status === 'accepted' ? 'default' : 'outline'}>
                        {o.status === 'accepted'
                          ? 'Aceptada'
                          : o.status === 'rejected'
                            ? 'Rechazada'
                            : o.expired
                              ? 'Caducada'
                              : 'Pendiente'}
                      </Badge>
                      {o.status === 'sent' && !o.expired && o.expiresAt && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          Caduca {relativeDays(o.expiresAt)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SalesPage>
  );
}
