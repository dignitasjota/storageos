'use client';

import { ArrowLeft, Check, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { contractDepositLabel, SettleDepositDialog } from '../deposit-card';
import { InspectionPhotosCard } from '../inspection-photos-card';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import {
  useContract,
  useContractMoveOut,
  useEndContract,
  useRequestEndContract,
} from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur } from '@/lib/format';

/** La salida de un inquilino en una pantalla, de la fecha a cerrar el contrato. */
export default function ContractMoveOutPage() {
  const id = useParams<{ id: string }>()?.id;
  const router = useRouter();
  const contract = useContract(id);
  const summary = useContractMoveOut(id);
  const requestEnd = useRequestEndContract();
  const end = useEndContract();
  const ask = useConfirm();
  const [date, setDate] = useState('');
  const [settling, setSettling] = useState(false);

  const c = contract.data;
  const s = summary.data;
  if (!c || !s) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const live = c.status === 'active' || c.status === 'ending';
  const depositOpen = c.depositAmount > 0 && c.depositStatus === 'held';

  async function setEndDate() {
    try {
      await requestEnd.mutateAsync({ id: c!.id, body: { endDate: date } });
      toast.success('Baja anotada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function close() {
    const ok = await ask({
      title: 'Cerrar el contrato',
      description:
        'El contrato se cierra hoy: el trastero queda libre, se retira el acceso del inquilino si no tiene otro contrato y deja de facturarse. No se puede deshacer.',
      confirmLabel: 'Cerrar el contrato',
      destructive: true,
    });
    if (!ok) return;
    try {
      await end.mutateAsync({ id: c!.id });
      toast.success('Contrato cerrado.');
      router.push(`/contracts/${c!.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cerrar.');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={`/contracts/${c.id}`}>
          <ArrowLeft className="mr-1 h-4 w-4" /> {c.contractNumber}
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Salida del inquilino</h1>
        <p className="text-sm text-muted-foreground">
          {c.customerName} · {c.facilityName} · {c.unitCode}
        </p>
      </div>

      <Step n={1} title="Fecha de salida" done={c.status === 'ending'}>
        {c.status === 'ending' ? (
          <p className="text-sm">
            Último día: {c.endDate ? formatDate(c.endDate) : 'sin fecha'}. El contrato se cierra
            solo después de esa fecha si tienes activada la finalización automática.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="out-date">Último día</Label>
              <Input
                id="out-date"
                type="date"
                min={localDateString()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <Button onClick={() => void setEndDate()} disabled={!date || requestEnd.isPending}>
              Anotar la baja
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              Preaviso del contrato: {c.cancellationNoticeDays} días.
            </p>
          </div>
        )}
      </Step>

      <Step n={2} title="Fotos de salida" done={s.checkoutPhotos > 0}>
        <InspectionPhotosCard contractId={c.id} kind="checkout" />
      </Step>

      <Step n={3} title="Facturas pendientes" done={s.pendingTotal <= 0}>
        {s.pendingInvoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tiene nada pendiente.</p>
        ) : (
          <ul className="divide-y text-sm">
            {s.pendingInvoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-1.5">
                <Link href={`/invoices/${i.id}`} className="font-mono text-xs hover:underline">
                  {i.number}
                </Link>
                <span className="tabular-nums">{formatEur(i.pending)}</span>
              </li>
            ))}
          </ul>
        )}
      </Step>

      <Step n={4} title="Fianza" done={!depositOpen}>
        <p className="text-sm">
          {c.depositAmount > 0
            ? `${formatEur(c.depositAmount)} · ${contractDepositLabel(c)}`
            : 'Este contrato no lleva fianza.'}
        </p>
        {depositOpen && c.depositCollected && (
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setSettling(true)}>
            Liquidar fianza
          </Button>
        )}
        {depositOpen && !c.depositCollected && (
          <p className="mt-1 text-xs text-muted-foreground">
            Sin cobrar: no hay nada que devolver.
          </p>
        )}
      </Step>

      {s.prepaidCredit && (
        <Step n={5} title="Abono de lo pagado por adelantado" done={false}>
          <p className="text-sm">
            Quedan {s.prepaidCredit.months}{' '}
            {s.prepaidCredit.months === 1 ? 'mes entero' : 'meses enteros'} sin usar: se abonan{' '}
            {formatEur(s.prepaidCredit.amount)}, cobrando los meses usados a la cuota mensual, sin
            el descuento del pago por adelantado. Al cerrar se crea el abono en borrador: revísalo,
            emítelo y devuelve el importe.
          </p>
        </Step>
      )}

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {s.otherLiveContracts > 0
              ? 'Conserva el acceso: tiene otro contrato en vigor.'
              : s.hasLiveAccess
                ? 'Al cerrar se le retira el acceso.'
                : 'No tiene accesos activos.'}
          </p>
          <Button onClick={() => void close()} disabled={!live || end.isPending}>
            Cerrar el contrato
          </Button>
        </CardContent>
      </Card>

      <SettleDepositDialog contract={c} open={settling} onClose={() => setSettling(false)} />
    </div>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className={`inline-flex size-6 items-center justify-center rounded-full text-xs ${
              done ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
            }`}
          >
            {done ? <Check className="size-3" /> : n}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
