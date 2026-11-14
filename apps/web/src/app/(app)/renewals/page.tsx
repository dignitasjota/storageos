'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Download, FileSignature, Phone } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { AnniversaryCard } from './anniversary-card';

import type { RenewalRowDto, RenewalWindow } from '@storageos/shared';

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { downloadCsv } from '@/lib/csv';
import { useRenewContract } from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import { useRenewalsInbox, useSendRenewalOffer } from '@/lib/portfolio/hooks';
import { useAnniversaryDue, useAnniversarySettings } from '@/lib/renewals/hooks';

const WINDOWS: { value: RenewalWindow; label: string }[] = [
  { value: '30', label: '30 días' },
  { value: '60', label: '60 días' },
  { value: '90', label: '90 días' },
  { value: 'overdue', label: 'Vencidos' },
];

const RISK: Record<RenewalRowDto['risk'], { label: string; className: string }> = {
  high: { label: 'Alto', className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
  medium: {
    label: 'Medio',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  low: { label: 'Bajo', className: 'bg-muted text-muted-foreground' },
};

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

function tenure(months: number): string {
  if (months < 1) return 'Menos de 1 mes';
  if (months < 12) return `${months} ${months === 1 ? 'mes' : 'meses'}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return `${y} ${y === 1 ? 'año' : 'años'}${m ? ` y ${m} m` : ''}`;
}

export default function RenewalsPage() {
  const [window, setWindow] = useState<RenewalWindow>('60');
  const facilityId = useHeaderFacilityId();
  const renewals = useRenewalsInbox(window, facilityId);
  const [renewing, setRenewing] = useState<RenewalRowDto | null>(null);
  const [offering, setOffering] = useState<RenewalRowDto | null>(null);
  const items = renewals.data ?? [];

  function exportCsv() {
    downloadCsv(`renovaciones-${window}.csv`, [
      [
        'Contrato',
        'Inquilino',
        'Teléfono',
        'Email',
        'Trastero',
        'Local',
        'Vence',
        'Renovación',
        'Cuota (sin IVA)',
        'Antigüedad (meses)',
        'Deuda vencida',
        'Riesgo de baja',
        'Oferta enviada',
      ],
      ...items.map((r) => [
        r.contractNumber,
        r.customerName,
        r.customerPhone ?? '',
        r.customerEmail ?? '',
        r.unitCode,
        r.facilityName,
        formatDate(r.endDate),
        r.status === 'ending' ? 'En baja' : r.autoRenew ? 'Se prorroga sola' : 'A mano',
        r.priceMonthly,
        r.monthsAsCustomer,
        r.debt,
        RISK[r.risk].label,
        r.pendingOffer ? 'Sí' : 'No',
      ]),
    ]);
  }

  const columns: ColumnDef<RenewalRowDto>[] = [
    {
      id: 'customer',
      header: 'Inquilino',
      accessorFn: (c) => `${c.customerName} ${c.customerPhone ?? ''} ${c.customerEmail ?? ''}`,
      cell: ({ row }) => (
        <div className="min-w-0">
          <Link
            href={`/customers/${row.original.customerId}`}
            className="font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.customerName}
          </Link>
          {row.original.customerPhone && (
            <a
              href={`tel:${row.original.customerPhone}`}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <Phone className="h-3 w-3" /> {row.original.customerPhone}
            </a>
          )}
        </div>
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
      id: 'tenure',
      header: 'Antigüedad',
      accessorFn: (c) => c.monthsAsCustomer,
      cell: ({ row }) => tenure(row.original.monthsAsCustomer),
    },
    {
      id: 'debt',
      header: 'Deuda',
      accessorFn: (c) => c.debt,
      cell: ({ row }) =>
        row.original.debt > 0 ? (
          <span className="font-medium text-red-600 dark:text-red-400">
            {formatEur(row.original.debt)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'risk',
      header: 'Riesgo de baja',
      accessorFn: (c) => (c.risk === 'high' ? 2 : c.risk === 'medium' ? 1 : 0),
      cell: ({ row }) => (
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${RISK[row.original.risk].className}`}
          title={row.original.riskFactors.join(' · ') || undefined}
        >
          {RISK[row.original.risk].label}
        </span>
      ),
    },
    {
      id: 'endDate',
      header: 'Vence',
      accessorFn: (c) => c.endDate,
      cell: ({ row }) => <DueLabel endDate={row.original.endDate} />,
    },
    {
      id: 'renewal',
      header: 'Renovación',
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.status === 'ending' ? (
            <Badge variant="destructive">En baja</Badge>
          ) : row.original.autoRenew ? (
            <Badge variant="default">Se prorroga sola</Badge>
          ) : (
            <Badge variant="outline">A mano</Badge>
          )}
          {row.original.pendingOffer && <Badge variant="secondary">Oferta enviada</Badge>}
        </div>
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
            {!row.original.pendingOffer && (
              <Button size="sm" variant="ghost" onClick={() => setOffering(row.original)}>
                <FileSignature className="mr-1 h-4 w-4" /> Ofrecer
              </Button>
            )}
          </Can>
        </div>
      ),
    },
  ];

  const overdueCount = window === 'overdue' ? items.length : 0;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Renovaciones</h1>
        <p className="text-sm text-muted-foreground">
          Contratos que vencen pronto y los ya vencidos que siguen abiertos. Renueva tú o envía una
          oferta que el inquilino firma desde su área de clientes.
        </p>
      </div>

      <AnniversaryCard />

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base">
            Por vencer
            {overdueCount > 0 && (
              <span className="ml-2 text-sm font-normal text-red-600 dark:text-red-400">
                {overdueCount} {overdueCount === 1 ? 'vencido' : 'vencidos'}
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={window} onValueChange={(v) => setWindow(v as RenewalWindow)}>
              <TabsList>
                {WINDOWS.map((w) => (
                  <TabsTrigger key={w.value} value={w.value}>
                    {w.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={items.length === 0}>
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {renewals.isError ? (
            <SectionError onRetry={() => void renewals.refetch()} />
          ) : (
            <DataTable
              columns={columns}
              data={items}
              isLoading={renewals.isLoading}
              rowHref={(c) => `/contracts/${c.contractId}`}
              searchPlaceholder="Buscar inquilino, teléfono o trastero..."
              emptyText={
                window === 'overdue'
                  ? 'No hay contratos vencidos abiertos.'
                  : `Ningún contrato vence en los próximos ${window} días.`
              }
            />
          )}
        </CardContent>
      </Card>
      {renewing && <RenewDialog contract={renewing} onClose={() => setRenewing(null)} />}
      {offering && <OfferDialog contract={offering} onClose={() => setOffering(null)} />}
    </div>
  );
}

/** Renovar sin salir de la lista; propone la cuota de la actualización anual si toca. */
function RenewDialog({ contract: c, onClose }: { contract: RenewalRowDto; onClose: () => void }) {
  const renew = useRenewContract();
  const settings = useAnniversarySettings();
  const due = useAnniversaryDue(!!settings.data?.enabled);
  const suggested = due.data?.find((d) => d.contractId === c.contractId)?.newPrice;
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
        id: c.contractId,
        body: {
          months: monthsN,
          expectedEndDate: c.endDate,
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

/** Oferta de renovación: el inquilino la firma como anexo y se renueva sola. */
function OfferDialog({ contract: c, onClose }: { contract: RenewalRowDto; onClose: () => void }) {
  const send = useSendRenewalOffer();
  const settings = useAnniversarySettings();
  const due = useAnniversaryDue(!!settings.data?.enabled);
  const suggested = due.data?.find((d) => d.contractId === c.contractId)?.newPrice;
  const [months, setMonths] = useState('12');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const monthsN = Math.floor(Number(months));

  async function submit() {
    const newPrice = price.trim() ? Number(price.replace(',', '.')) : undefined;
    if (newPrice !== undefined && !(newPrice > 0)) {
      toast.error('La cuota no es válida.');
      return;
    }
    try {
      const res = await send.mutateAsync({
        contractId: c.contractId,
        input: {
          months: monthsN,
          ...(newPrice !== undefined ? { newPrice } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      toast.success(
        res.emailed
          ? 'Oferta enviada. Al firmarla, el contrato se renueva solo.'
          : 'Oferta creada. No tiene email: pásale el enlace desde la pestaña Firma del contrato.',
      );
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar la oferta.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ofrecer la renovación a {c.customerName}</DialogTitle>
          <DialogDescription>
            Le llega por correo y la ve en su área de clientes. Al firmarla, el contrato se renueva
            solo con lo que pongas aquí.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="offer-months">Meses de renovación</Label>
            <Input
              id="offer-months"
              inputMode="numeric"
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="offer-price">Cuota del nuevo periodo (€ al mes, sin IVA)</Label>
            <Input
              id="offer-price"
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
          </div>
          <div>
            <Label htmlFor="offer-note">Algo más que quieras decirle (opcional)</Label>
            <Textarea
              id="offer-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Por renovar un año te mantenemos la cuota."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!(monthsN >= 1 && monthsN <= 60) || send.isPending}
          >
            Enviar la oferta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
