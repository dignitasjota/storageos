'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Empty, errorText, PageHeader, SalesPage } from '@/components/admin/sales/common';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAssignSalesAccount,
  useDecideClaim,
  useDecideItem,
  usePendingAssignments,
  useSalesTeam,
  useTeamClaims,
  useTeamCommissions,
} from '@/lib/admin/sales-team-hooks';
import { formatDate, formatEur } from '@/lib/format';

const NONE = '-';

function AssignmentRow({
  a,
  reps,
}: {
  a: {
    leadId: string;
    tenantId: string;
    tenantName: string;
    repId: string;
    repName: string;
    registeredAt: string | null;
  };
  reps: { id: string; fullName: string }[];
}) {
  const assign = useAssignSalesAccount();
  const [repId, setRepId] = useState(a.repId);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <div className="min-w-0">
        <Link href={`/admin/tenants/${a.tenantId}`} className="font-medium hover:underline">
          {a.tenantName}
        </Link>
        <p className="text-xs text-muted-foreground">
          Lo llevaba {a.repName}; se registró sin su código
          {a.registeredAt && ` el ${formatDate(a.registeredAt)}`}.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Select value={repId} onValueChange={setRepId}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Sin comercial</SelectItem>
            {reps.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={assign.isPending}
          onClick={() =>
            void assign
              .mutateAsync({ tenantId: a.tenantId, repId: repId === NONE ? null : repId })
              .then(() => toast.success('Hecho.'))
              .catch((e) => toast.error(errorText(e)))
          }
        >
          {repId === NONE ? 'Sin comercial' : 'Asignar'}
        </Button>
      </div>
    </li>
  );
}

export default function SalesPendingPage() {
  const assignments = usePendingAssignments();
  const claims = useTeamClaims('pending');
  const items = useTeamCommissions({ status: 'pending' });
  const team = useSalesTeam();
  const decideClaim = useDecideClaim();
  const decideItem = useDecideItem();
  const confirm = useConfirm();
  const reps = (team.data?.reps ?? []).filter((r) => r.isActive);

  async function reject(kind: 'claim' | 'item', id: string) {
    const r = await confirm({
      title: 'No cuenta para su comisión',
      input: { label: 'Motivo (lo ve el comercial)' },
      confirmLabel: 'Rechazar',
      destructive: true,
    });
    if (!r) return;
    const args = { id, approve: false, ...(r.value ? { note: r.value } : {}) };
    try {
      if (kind === 'claim') await decideClaim.mutateAsync(args);
      else await decideItem.mutateAsync(args);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <SalesPage>
      <PageHeader
        title="Por decidir"
        description="Lo que espera tu decisión del equipo comercial. Las peticiones de cambios (plan, precio, días de prueba) están en «Hoy»."
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cuentas sin asignar</CardTitle>
          <CardDescription>
            Prospectos de un comercial que se han registrado sin su código. Solo es suyo si tú lo
            decides.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {assignments.isLoading ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (assignments.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Ninguna.</p>
          ) : (
            <ul className="divide-y">
              {assignments.data!.map((a) => (
                <AssignmentRow key={a.tenantId} a={a} reps={reps} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Extras contratados tras la venta</CardTitle>
          <CardDescription>
            Solo cuentan para la comisión si el comercial intervino. Mira su nota y si venía de una
            propuesta suya.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(claims.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Ninguno.</p>
          ) : (
            <ul className="divide-y">
              {claims.data!.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p>
                      <strong>{c.addonName}</strong> ({formatEur(c.monthly)}/mes) ·{' '}
                      <Link href={`/admin/tenants/${c.tenantId}`} className="hover:underline">
                        {c.tenantName}
                      </Link>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.repName} · contratado {formatDate(c.assignedAt ?? c.createdAt)}
                      {c.fromOffer && ' · desde una propuesta del comercial'}
                    </p>
                    {c.repNote && <p className="text-xs">Nota del comercial: {c.repNote}</p>}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      disabled={decideClaim.isPending}
                      onClick={() =>
                        void decideClaim
                          .mutateAsync({ id: c.id, approve: true })
                          .catch((e) => toast.error(errorText(e)))
                      }
                    >
                      Cuenta
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void reject('claim', c.id)}>
                      No cuenta
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Trabajos extra</CardTitle>
          <CardDescription>
            Lo que un comercial anota para cobrar (p. ej. una migración de datos).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(items.data ?? []).length === 0 ? (
            <Empty>Ninguno.</Empty>
          ) : (
            <ul className="divide-y">
              {items.data!.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p>
                      <strong>{i.description}</strong> · {formatEur(i.amount)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {i.repName} ·{' '}
                      <Link href={`/admin/tenants/${i.tenantId}`} className="hover:underline">
                        {i.tenantName}
                      </Link>{' '}
                      · {formatDate(i.createdAt)}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      disabled={decideItem.isPending}
                      onClick={() =>
                        void decideItem
                          .mutateAsync({ id: i.id, approve: true })
                          .catch((e) => toast.error(errorText(e)))
                      }
                    >
                      Aprobar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void reject('item', i.id)}>
                      Rechazar
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </SalesPage>
  );
}
