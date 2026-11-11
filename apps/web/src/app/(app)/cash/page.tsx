'use client';

import { FileDown, Loader2, LockOpen, Wallet } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  CashLinesCard,
  denominationsCents,
  DenominationsInput,
  type Denominations,
} from './cash-count';
import { ClosuresHistory } from './closures-history';
import { CashMovementsCard } from './movements-card';

import type { CashClosureDto, CashMethodKey } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import {
  downloadClosurePdf,
  useCashSummary,
  useCloseCash,
  useReopenCashClosure,
} from '@/lib/cash/hooks';
import { localDateString } from '@/lib/dates';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';

const METHODS: { key: CashMethodKey; label: string }[] = [
  { key: 'cash', label: 'Efectivo' },
  { key: 'card', label: 'Tarjeta' },
  { key: 'bizum', label: 'Bizum' },
  { key: 'sepaDebit', label: 'Domiciliación SEPA' },
  { key: 'bankTransfer', label: 'Transferencia' },
  { key: 'other', label: 'Otros' },
];

/** Valor del selector para la caja de toda la empresa (Radix no admite ''). */
const GLOBAL = 'global';

/** «12,50» o «12.50» → céntimos; null si no es un importe. */
function parseCents(v: string): number | null {
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export default function CashPage() {
  const me = useMe();
  const params = useSearchParams();
  const companyWide = !Array.isArray(me.data?.facilityScope);
  // Desde «Hoy» se llega con el día y la caja que faltan por cerrar.
  const [date, setDate] = useState(() => {
    const d = params.get('date');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : localDateString();
  });
  // Empieza con el local de la cabecera (o el del enlace); quien ve todos los
  // locales puede elegir la caja global, el resto solo la de sus locales.
  const [facilityFilterId, setFacilityFilterId] = useFacilityFilterState();
  const [linkFacility] = useState(() => params.get('facilityId'));
  const facilities = useFacilities();
  const fallback = companyWide ? '' : (facilities.data?.[0]?.id ?? '');
  // Hasta que se elige otra caja, manda la del enlace (sin local = la global).
  const facilityId =
    params.get('date') !== null ? (linkFacility ?? fallback) : (facilityFilterId ?? fallback);
  const ready = !!me.data && (companyWide || !!facilityId);
  const summary = useCashSummary(date, facilityId || undefined, ready);
  const close = useCloseCash();
  const [counted, setCounted] = useState('');
  const [byNotes, setByNotes] = useState(false);
  const [denominations, setDenominations] = useState<Denominations>({});
  const [notes, setNotes] = useState('');
  const [reopening, setReopening] = useState<CashClosureDto | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const s = summary.data;
  const closure = s?.closure ?? null;
  const countedCents = byNotes
    ? denominationsCents(denominations)
    : counted
      ? parseCents(counted)
      : null;
  const diffCents =
    countedCents !== null && s ? countedCents - Math.round(s.expectedCash * 100) : null;

  async function onClose() {
    if (countedCents === null) {
      toast.error('Introduce el efectivo contado (por ejemplo, 120,50).');
      return;
    }
    try {
      await close.mutateAsync({
        date,
        countedCash: countedCents / 100,
        ...(facilityId ? { facilityId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(byNotes ? { denominations } : {}),
      });
      toast.success('Caja cerrada.');
      setCounted('');
      setDenominations({});
      setNotes('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cerrar la caja.');
    }
  }

  const summaryError = summary.error instanceof ApiError ? summary.error.body.message : null;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Wallet className="size-5" /> Cierre de caja
          </h1>
          <p className="text-sm text-muted-foreground">
            Arqueo del efectivo del día: lo cobrado menos lo devuelto en efectivo.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Caja</Label>
            <Select
              value={facilityId || GLOBAL}
              onValueChange={(v) => {
                if (params.get('date')) window.history.replaceState(null, '', '/cash');
                setFacilityFilterId(v === GLOBAL ? undefined : v);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Elige un local" />
              </SelectTrigger>
              <SelectContent>
                {companyWide && <SelectItem value={GLOBAL}>Toda la empresa</SelectItem>}
                {(facilities.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Día</Label>
            <DateSelect value={date} onChange={(v) => setDate(v ?? localDateString())} />
          </div>
        </div>
      </div>
      {companyWide && !facilityId && (
        <p className="text-xs text-muted-foreground">
          La caja de toda la empresa incluye los cobros sin local (facturas sueltas); por eso puede
          no coincidir con la suma de las cajas de cada local.
        </p>
      )}

      {!ready || summary.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : summary.isError ? (
        summaryError ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {summaryError}
          </p>
        ) : (
          <SectionError onRetry={() => void summary.refetch()} />
        )
      ) : s ? (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Lo que entró y lo que salió ese día. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Cobros del día ({s.count})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {METHODS.map((m) =>
                m.key === 'cash' || s[m.key] !== 0 ? (
                  <Row key={m.key} label={m.label} value={s[m.key]} strong={m.key === 'cash'} />
                ) : null,
              )}
              <div className="mt-1 flex items-center justify-between border-t pt-1.5 font-semibold">
                <span>Total cobrado</span>
                <span className="tabular-nums">{formatEur(s.total)}</span>
              </div>
              {(s.refundsTotal > 0 || s.returned > 0 || s.depositReturnsCash > 0) && (
                <div className="mt-1 space-y-1.5 border-t pt-1.5">
                  {METHODS.filter((m) => s.refunds[m.key] > 0).map((m) => (
                    <Row
                      key={m.key}
                      label={`Devuelto a inquilinos · ${m.label.toLowerCase()}`}
                      value={-s.refunds[m.key]}
                      negative
                    />
                  ))}
                  {s.depositReturnsCash > 0 && (
                    <Row
                      label="Fianzas devueltas en efectivo"
                      value={-s.depositReturnsCash}
                      negative
                    />
                  )}
                  {s.returned > 0 && (
                    <Row label="Cobros devueltos por el banco" value={-s.returned} negative />
                  )}
                </div>
              )}
              {(s.movementsIn > 0 || s.movementsOut > 0) && (
                <div className="mt-1 space-y-1.5 border-t pt-1.5">
                  {s.movementsIn > 0 && <Row label="Fondo y cambio" value={s.movementsIn} />}
                  {s.movementsOut > 0 && (
                    <Row label="Retiradas al banco" value={-s.movementsOut} negative />
                  )}
                </div>
              )}
              <div className="mt-1 flex items-center justify-between border-t pt-1.5 font-semibold">
                <span>Esperado en caja (efectivo)</span>
                <span className="tabular-nums">{formatEur(s.expectedCash)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Arqueo: cerrar la caja. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Arqueo de efectivo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {closure ? (
                <div className="space-y-1.5">
                  <Row label="Esperado (efectivo)" value={closure.expectedCash} />
                  <Row label="Contado" value={closure.countedCash} />
                  <div className="flex items-center justify-between font-semibold">
                    <span>Diferencia</span>
                    <span
                      className={
                        closure.difference === 0
                          ? 'tabular-nums text-green-600 dark:text-green-400'
                          : 'tabular-nums text-destructive'
                      }
                    >
                      {formatEur(closure.difference)}
                    </span>
                  </div>
                  {closure.expectedCash !== s.expectedCash && (
                    <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      Después del cierre hubo movimientos de ese día: ahora se esperan{' '}
                      {formatEur(s.expectedCash)}.
                    </p>
                  )}
                  {closure.notes && (
                    <p className="text-xs text-muted-foreground">Nota: {closure.notes}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Cerrada por {closure.closedByName ?? '—'} el {formatDateTime(closure.closedAt)}.
                    Con la caja cerrada no se registran cobros ni devoluciones en efectivo de ese
                    día.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pdfLoading}
                      onClick={() => {
                        setPdfLoading(true);
                        downloadClosurePdf(closure)
                          .catch(() => toast.error('No se pudo generar el PDF del cierre.'))
                          .finally(() => setPdfLoading(false));
                      }}
                    >
                      <FileDown className="mr-1 size-4" /> PDF para firmar
                    </Button>
                    <Can permission="invoices:manage">
                      <Button variant="outline" size="sm" onClick={() => setReopening(closure)}>
                        <LockOpen className="mr-1 size-4" /> Reabrir la caja
                      </Button>
                    </Can>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Cuenta el efectivo que hay en caja y regístralo. Esperado:{' '}
                    <span className="font-medium text-foreground">{formatEur(s.expectedCash)}</span>
                    .
                  </p>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={byNotes}
                      onChange={(e) => setByNotes(e.target.checked)}
                    />
                    Contar por billetes y monedas
                  </label>
                  <div>
                    {byNotes ? (
                      <>
                        <DenominationsInput value={denominations} onChange={setDenominations} />
                        <p className="mt-2 text-sm">
                          Contado:{' '}
                          <span className="font-medium tabular-nums">
                            {formatEur(denominationsCents(denominations) / 100)}
                          </span>
                        </p>
                      </>
                    ) : (
                      <>
                        <Label className="text-xs" htmlFor="cash-counted">
                          Efectivo contado (€)
                        </Label>
                        <Input
                          id="cash-counted"
                          inputMode="decimal"
                          placeholder="0,00"
                          value={counted}
                          onChange={(e) => setCounted(e.target.value)}
                        />
                      </>
                    )}
                    {diffCents !== null ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Diferencia:{' '}
                        <span
                          className={
                            diffCents === 0 ? 'tabular-nums' : 'tabular-nums text-destructive'
                          }
                        >
                          {formatEur(diffCents / 100)}
                        </span>
                      </p>
                    ) : counted && !byNotes ? (
                      <p className="mt-1 text-xs text-destructive">Importe no válido.</p>
                    ) : null}
                  </div>
                  <div>
                    <Label className="text-xs" htmlFor="cash-notes">
                      Notas (opcional)
                    </Label>
                    <Textarea
                      id="cash-notes"
                      rows={2}
                      maxLength={500}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </div>
                  <Can permission="payments:charge">
                    <Button
                      onClick={() => void onClose()}
                      disabled={close.isPending || (!byNotes && !counted)}
                    >
                      Cerrar la caja del día
                    </Button>
                  </Can>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {s && ready && !summary.isError && (
        <div className="grid gap-4 md:grid-cols-2">
          <CashMovementsCard
            key={`${date}|${facilityId}|${s.closure?.id ?? 'open'}`}
            date={date}
            facilityId={facilityId}
            summary={s}
          />
          <CashLinesCard summary={s} />
        </div>
      )}

      <ClosuresHistory companyWide={companyWide} facilities={facilities.data ?? []} />

      {reopening && <ReopenDialog closure={reopening} onClose={() => setReopening(null)} />}
    </div>
  );
}

function ReopenDialog({ closure, onClose }: { closure: CashClosureDto; onClose: () => void }) {
  const reopen = useReopenCashClosure();
  const [reason, setReason] = useState('');

  async function submit() {
    try {
      await reopen.mutateAsync({ id: closure.id, input: { reason: reason.trim() } });
      toast.success('Caja reabierta: registra lo que faltaba y vuelve a cerrarla.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reabrir.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reabrir la caja del {formatDate(closure.date)}</DialogTitle>
          <DialogDescription>
            Podrás registrar cobros y devoluciones en efectivo de ese día y volver a cerrarla. El
            cierre actual queda guardado como reabierto, con el motivo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="reopen-reason">Motivo</Label>
          <Textarea
            id="reopen-reason"
            rows={2}
            maxLength={500}
            placeholder="Faltaba registrar el cobro en efectivo de…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button
            disabled={reopen.isPending || reason.trim().length < 3}
            onClick={() => void submit()}
          >
            Reabrir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  strong,
  negative,
}: {
  label: string;
  value: number;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${negative ? 'text-destructive' : ''}`}>
      <span className={strong ? 'font-medium' : negative ? '' : 'text-muted-foreground'}>
        {label}
      </span>
      <span className="tabular-nums">{formatEur(value)}</span>
    </div>
  );
}
