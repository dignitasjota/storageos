'use client';

import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { AnniversaryCard } from './anniversary-card';

import type { ContractDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useRenewContract } from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur } from '@/lib/format';
import { useAnniversaryDue, useAnniversarySettings, useRenewals } from '@/lib/renewals/hooks';

/** Días que faltan (negativo = vencido) en días de calendario. */
function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date(`${localDateString()}T00:00:00Z`);
  return Math.round(
    (new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() - today.getTime()) / 86_400_000,
  );
}

function DueLabel({ endDate }: { endDate: string | null }) {
  const d = daysLeft(endDate);
  if (d === null) return <span>—</span>;
  return (
    <span className="whitespace-nowrap">
      {formatDate(endDate)}{' '}
      <span
        className={`text-xs ${d < 0 ? 'font-medium text-red-600 dark:text-red-400' : d <= 15 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
      >
        {d < 0 ? `(vencido hace ${-d} d)` : d === 0 ? '(hoy)' : `(${d} d)`}
      </span>
    </span>
  );
}

export default function RenewalsPage() {
  const renewals = useRenewals();
  const [renewing, setRenewing] = useState<ContractDto | null>(null);
  const items = renewals.data ?? [];
  const overdue = items.filter((c) => (daysLeft(c.endDate) ?? 0) < 0).length;

  const columns: ColumnDef<ContractDto>[] = [
    {
      id: 'customer',
      header: 'Inquilino',
      accessorFn: (c) => c.customerName,
      cell: ({ row }) => (
        <Link
          href={`/customers/${row.original.customerId}`}
          className="font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {row.original.customerName}
        </Link>
      ),
    },
    {
      id: 'unit',
      header: 'Trastero',
      accessorFn: (c) => `${c.unitCode} ${c.facilityName}`,
      cell: ({ row }) => `${row.original.unitCode} · ${row.original.facilityName}`,
    },
    {
      id: 'price',
      header: 'Cuota',
      accessorFn: (c) => c.priceMonthly,
      cell: ({ row }) => formatEur(row.original.priceMonthly),
    },
    {
      id: 'endDate',
      header: 'Vence',
      accessorFn: (c) => c.endDate ?? '',
      cell: ({ row }) => <DueLabel endDate={row.original.endDate} />,
    },
    {
      id: 'renewal',
      header: 'Renovación',
      cell: ({ row }) =>
        row.original.status === 'ending' ? (
          <Badge variant="destructive">En baja</Badge>
        ) : row.original.autoRenew ? (
          <Badge variant="default">Se prorroga sola</Badge>
        ) : (
          <Badge variant="outline">A mano</Badge>
        ),
    },
    {
      id: 'actions',
      header: '',
      meta: { mobileLabel: '' },
      cell: ({ row }) => (
        <div className="flex flex-wrap justify-end gap-2" onClick={(e) => e.stopPropagation()}>
          <Can permission="contracts:manage">
            <Button size="sm" variant="outline" onClick={() => setRenewing(row.original)}>
              Renovar
            </Button>
          </Can>
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/contracts/${row.original.id}`}>Gestionar</Link>
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Renovaciones</h1>
        <p className="text-sm text-muted-foreground">
          Contratos que vencen en los próximos 60 días y los ya vencidos que siguen abiertos.
          Renueva o contacta a tiempo para no perder al inquilino.
        </p>
      </div>

      <AnniversaryCard />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Por vencer
            {overdue > 0 && (
              <span className="ml-2 text-sm font-normal text-red-600 dark:text-red-400">
                {overdue} {overdue === 1 ? 'vencido' : 'vencidos'}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {renewals.isError ? (
            <SectionError onRetry={() => void renewals.refetch()} />
          ) : (
            <DataTable
              columns={columns}
              data={items}
              isLoading={renewals.isLoading}
              rowHref={(c) => `/contracts/${c.id}`}
              searchPlaceholder="Buscar inquilino o trastero..."
              emptyText="Ningún contrato vence en los próximos 60 días."
            />
          )}
        </CardContent>
      </Card>
      {renewing && <RenewDialog contract={renewing} onClose={() => setRenewing(null)} />}
    </div>
  );
}

/** Renovar sin salir de la lista; propone la cuota de la actualización anual si toca. */
function RenewDialog({ contract: c, onClose }: { contract: ContractDto; onClose: () => void }) {
  const renew = useRenewContract();
  const settings = useAnniversarySettings();
  const due = useAnniversaryDue(!!settings.data?.enabled);
  const suggested = due.data?.find((d) => d.contractId === c.id)?.newPrice;
  const [months, setMonths] = useState('12');
  const [price, setPrice] = useState('');
  const monthsN = Math.floor(Number(months));
  const overdue = (daysLeft(c.endDate) ?? 0) < 0;

  async function submit() {
    const newPrice = price.trim() ? Number(price.replace(',', '.')) : null;
    if (newPrice !== null && !(newPrice > 0)) {
      toast.error('La cuota no es válida.');
      return;
    }
    try {
      await renew.mutateAsync({
        id: c.id,
        body: {
          months: monthsN,
          expectedEndDate: c.endDate ? c.endDate.slice(0, 10) : null,
          ...(newPrice !== null ? { newPrice } : {}),
        },
      });
      toast.success('Contrato renovado. El inquilino recibirá un aviso.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo renovar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Renovar a {c.customerName}</DialogTitle>
          <DialogDescription>
            {c.unitCode} · vence el {formatDate(c.endDate)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="renew-months">Meses a añadir</Label>
            <Input
              id="renew-months"
              inputMode="numeric"
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {overdue ? 'Ya venció: se cuenta desde hoy.' : 'Se suma al fin actual.'}
              {c.status === 'ending' && ' Anula la baja: el contrato vuelve a activo.'}
            </p>
          </div>
          <div>
            <Label htmlFor="renew-price">Cuota del nuevo periodo (€ al mes, sin IVA)</Label>
            <Input
              id="renew-price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={`Vacío: sigue en ${formatEur(c.priceMonthly)}`}
            />
            {suggested != null && (
              <button
                type="button"
                className="mt-1 text-xs text-primary underline"
                onClick={() => setPrice(String(suggested))}
              >
                Usar la de la actualización anual: {formatEur(suggested)}
              </button>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Se aplica desde el día siguiente al fin actual. El inquilino recibe un solo correo con
              la nueva fecha y, si cambia, la cuota.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!(monthsN >= 1 && monthsN <= 60) || renew.isPending}
          >
            Renovar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
