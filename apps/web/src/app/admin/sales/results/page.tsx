'use client';

import {
  SALES_CLAIM_STATUS_LABELS,
  SALES_COMMISSION_KIND_LABELS,
  SALES_COMMISSION_STATUS_LABELS,
  type SalesAddonClaimDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Empty, errorText, PageHeader, SalesPage, Stat } from '@/components/admin/sales/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useSalesClaimNote,
  useSalesClaims,
  useSalesCommissions,
  useSalesSettlements,
  useSalesTargets,
} from '@/lib/admin/sales-hooks';
import { formatDate, formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const label = new Date(y, m - 1, 1).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function ClaimNote({ claim }: { claim: SalesAddonClaimDto }) {
  const save = useSalesClaimNote();
  const [note, setNote] = useState(claim.repNote ?? '');
  if (claim.status !== 'pending') {
    return claim.repNote ? (
      <span className="text-xs text-muted-foreground">{claim.repNote}</span>
    ) : null;
  }
  return (
    <div className="flex gap-1.5">
      <Input
        className="h-8 text-xs"
        placeholder="Cuéntale a la dirección cómo lo vendiste"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={save.isPending || note === (claim.repNote ?? '')}
        onClick={() =>
          void save
            .mutateAsync({ id: claim.id, repNote: note })
            .then(() => toast.success('Nota guardada.'))
            .catch((e) => toast.error(errorText(e)))
        }
      >
        Guardar
      </Button>
    </div>
  );
}

export default function SalesResultsPage() {
  const commissions = useSalesCommissions();
  const claims = useSalesClaims();
  const settlements = useSalesSettlements();
  const targets = useSalesTargets();
  const data = commissions.data;

  return (
    <SalesPage>
      <PageHeader
        title="Mis comisiones"
        description="Lo que llevas ganado, lo que falta por aprobar y lo que ya se ha liquidado."
      />
      {commissions.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Este mes" value={formatEur(data.totals.month)} tone="good" />
            <Stat label="Pendiente de liquidar" value={formatEur(data.totals.approvedUnsettled)} />
            <Stat label="Por aprobar" value={formatEur(data.totals.pending)} tone="warn" />
            <Stat label="Liquidado en total" value={formatEur(data.totals.settled)} />
          </div>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Tus condiciones</CardTitle>
              <CardDescription>Las fija la dirección; si tienes dudas, pregúntale.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
              <p>
                <strong>{data.plan.revenuePct} %</strong> de lo que pagan tus clientes (sin IVA)
                {data.plan.revenueMonths
                  ? ` durante sus primeros ${data.plan.revenueMonths} meses`
                  : ' mientras sigan pagando'}
                .
              </p>
              {data.plan.perSaleAmount > 0 && (
                <p>
                  <strong>{formatEur(data.plan.perSaleAmount)}</strong> por cada cliente que paga
                  por primera vez.
                </p>
              )}
              {data.plan.perAddonAmount > 0 && (
                <p>
                  <strong>{formatEur(data.plan.perAddonAmount)}</strong> por cada extra que vendas
                  después (cuando la dirección lo aprueba).
                </p>
              )}
              {data.plan.concepts.filter((c) => c.isActive).length > 0 && (
                <p className="sm:col-span-2">
                  Trabajos extra:{' '}
                  {data.plan.concepts
                    .filter((c) => c.isActive)
                    .map((c) => `${c.name} (${formatEur(c.amount)})`)
                    .join(' · ')}
                  . Se anotan desde la ficha del cliente.
                </p>
              )}
              {data.plan.notes && (
                <p className="text-muted-foreground sm:col-span-2">{data.plan.notes}</p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Tabs defaultValue="items">
        <TabsList className="flex-wrap">
          <TabsTrigger value="items">Movimientos</TabsTrigger>
          <TabsTrigger value="claims">Extras vendidos</TabsTrigger>
          <TabsTrigger value="settlements">Liquidaciones</TabsTrigger>
          <TabsTrigger value="targets">Objetivos</TabsTrigger>
        </TabsList>

        <TabsContent value="items">
          {!data || data.items.length === 0 ? (
            <Empty>Aún no hay comisiones. Llegan cuando tus clientes pagan.</Empty>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mes</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Concepto</TableHead>
                    <TableHead className="text-right">Importe</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {monthLabel(i.month)}
                      </TableCell>
                      <TableCell className="text-sm">{i.tenantName}</TableCell>
                      <TableCell className="text-sm">
                        {SALES_COMMISSION_KIND_LABELS[i.kind]}
                        <span className="block text-xs text-muted-foreground">{i.description}</span>
                        {i.decisionNote && (
                          <span className="block text-xs">Nota: {i.decisionNote}</span>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          i.amount < 0 && 'text-rose-600 dark:text-rose-400',
                        )}
                      >
                        {formatEur(i.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            i.status === 'approved'
                              ? 'default'
                              : i.status === 'rejected'
                                ? 'destructive'
                                : 'outline'
                          }
                        >
                          {i.settlementId ? 'Liquidada' : SALES_COMMISSION_STATUS_LABELS[i.status]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="claims">
          <p className="mb-2 text-sm text-muted-foreground">
            Los extras que contratan tus clientes después de la venta cuentan para tu comisión
            cuando la dirección comprueba que los vendiste tú. Los de la venta inicial cuentan
            solos.
          </p>
          {(claims.data ?? []).length === 0 ? (
            <Empty>Tus clientes no han contratado extras todavía.</Empty>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Extra</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Tu nota</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {claims.data!.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="text-sm">{c.tenantName}</TableCell>
                      <TableCell className="text-sm">
                        {c.addonName} · {formatEur(c.monthly)}/mes
                        <span className="block text-xs text-muted-foreground">
                          {c.partOfSale
                            ? 'En la venta inicial'
                            : `Contratado ${formatDate(c.assignedAt ?? c.createdAt)}`}
                          {c.fromOffer && ' · desde tu propuesta'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            c.status === 'approved'
                              ? 'default'
                              : c.status === 'rejected'
                                ? 'destructive'
                                : 'outline'
                          }
                        >
                          {SALES_CLAIM_STATUS_LABELS[c.status]}
                        </Badge>
                        {c.decisionNote && (
                          <span className="mt-0.5 block text-xs">{c.decisionNote}</span>
                        )}
                      </TableCell>
                      <TableCell className="min-w-[220px]">
                        <ClaimNote claim={c} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="settlements">
          {(settlements.data ?? []).length === 0 ? (
            <Empty>Aún no hay liquidaciones.</Empty>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mes</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settlements.data!.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-sm">
                        {monthLabel(s.month)}
                        <span className="block text-xs normal-case text-muted-foreground">
                          {s.itemsCount} movimientos
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatEur(s.total)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={s.status === 'paid' ? 'default' : 'outline'}>
                          {s.status === 'paid'
                            ? `Pagada ${formatDate(s.paidAt)}`
                            : 'Pendiente de pago'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="targets">
          {(targets.data ?? []).length === 0 ? (
            <Empty>La dirección no te ha puesto objetivos.</Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {targets.data!.map((t) => {
                const pctClients =
                  t.newClients > 0
                    ? Math.min(100, (t.achieved.newClients / t.newClients) * 100)
                    : 100;
                const pctMrr =
                  t.newMrr > 0 ? Math.min(100, (t.achieved.newMrr / t.newMrr) * 100) : 100;
                return (
                  <Card key={t.month}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{monthLabel(t.month)}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <div>
                        <p>
                          Clientes nuevos: {t.achieved.newClients} de {t.newClients}
                        </p>
                        <div className="mt-1 h-2 rounded-full bg-muted">
                          <div
                            className="h-2 rounded-full bg-primary"
                            style={{ width: `${pctClients}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <p>
                          Cuotas nuevas: {formatEur(t.achieved.newMrr)} de {formatEur(t.newMrr)} al
                          mes
                        </p>
                        <div className="mt-1 h-2 rounded-full bg-muted">
                          <div
                            className="h-2 rounded-full bg-primary"
                            style={{ width: `${pctMrr}%` }}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </SalesPage>
  );
}
