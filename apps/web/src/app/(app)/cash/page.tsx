'use client';

import { Loader2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useCashClosures, useCashSummary, useCloseCash } from '@/lib/cash/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export default function CashPage() {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [facilityId, setFacilityId] = useState(''); // '' = caja global
  const facilities = useFacilities();
  const summary = useCashSummary(date, facilityId || undefined);
  const closures = useCashClosures();
  const close = useCloseCash();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');

  const s = summary.data;
  const closure = s?.closure ?? null;

  async function onClose() {
    const countedCash = Number(counted);
    if (!Number.isFinite(countedCash) || countedCash < 0) {
      toast.error('Introduce el efectivo contado.');
      return;
    }
    try {
      await close.mutateAsync({
        date,
        countedCash,
        ...(facilityId ? { facilityId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success('Caja cerrada.');
      setCounted('');
      setNotes('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cerrar la caja.');
    }
  }

  const diff = counted !== '' && s ? Number(counted) - s.expectedCash : null;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Wallet className="size-5" /> Cierre de caja
          </h1>
          <p className="text-sm text-muted-foreground">Arqueo del efectivo cobrado en el día.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Caja</Label>
            <select
              className="h-10 w-48 rounded-md border bg-background px-3 text-sm"
              value={facilityId}
              onChange={(e) => setFacilityId(e.target.value)}
            >
              <option value="">Global (todos los locales)</option>
              {(facilities.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Día</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-40"
            />
          </div>
        </div>
      </div>

      {summary.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : s ? (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Resumen de cobros del día por método. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Cobros del día ({s.count})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <Row label="Efectivo" value={s.cash} strong />
              <Row label="Tarjeta" value={s.card} />
              <Row label="Domiciliación SEPA" value={s.sepaDebit} />
              <Row label="Transferencia" value={s.bankTransfer} />
              <Row label="Otros" value={s.other} />
              <div className="mt-1 flex items-center justify-between border-t pt-1.5 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{eur(s.total)}</span>
              </div>
              {s.cashRefunds > 0 && (
                <div className="mt-1 space-y-1.5 border-t pt-1.5">
                  <div className="flex items-center justify-between text-destructive">
                    <span>Reembolsos en efectivo</span>
                    <span className="tabular-nums">−{eur(s.cashRefunds)}</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold">
                    <span>Esperado en caja (efectivo)</span>
                    <span className="tabular-nums">{eur(s.expectedCash)}</span>
                  </div>
                </div>
              )}
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
                          ? 'tabular-nums text-green-600'
                          : 'tabular-nums text-destructive'
                      }
                    >
                      {eur(closure.difference)}
                    </span>
                  </div>
                  {closure.notes && (
                    <p className="text-xs text-muted-foreground">Nota: {closure.notes}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Cerrada por {closure.closedByName ?? '—'} el{' '}
                    {new Date(closure.closedAt).toLocaleString('es-ES')}
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Cuenta el efectivo en caja y regístralo. Esperado:{' '}
                    <span className="font-medium text-foreground">{eur(s.expectedCash)}</span>.
                  </p>
                  <div>
                    <Label className="text-xs">Efectivo contado (€)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={counted}
                      onChange={(e) => setCounted(e.target.value)}
                    />
                    {diff !== null && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Diferencia: <span className="tabular-nums">{eur(diff)}</span>
                      </p>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs">Notas (opcional)</Label>
                    <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </div>
                  <Button onClick={onClose} disabled={close.isPending || counted === ''}>
                    Cerrar caja del día
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Historial de cierres. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cierres recientes</CardTitle>
        </CardHeader>
        <CardContent>
          {(closures.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay cierres.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1">Día</th>
                    <th className="py-1">Caja</th>
                    <th className="py-1 text-right">Esperado</th>
                    <th className="py-1 text-right">Contado</th>
                    <th className="py-1 text-right">Diferencia</th>
                    <th className="py-1">Cerrado por</th>
                  </tr>
                </thead>
                <tbody>
                  {(closures.data ?? []).map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="py-1.5">{c.date}</td>
                      <td className="py-1.5 text-muted-foreground">{c.facilityName ?? 'Global'}</td>
                      <td className="py-1.5 text-right tabular-nums">{eur(c.expectedCash)}</td>
                      <td className="py-1.5 text-right tabular-nums">{eur(c.countedCash)}</td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${
                          c.difference === 0 ? '' : 'text-destructive'
                        }`}
                      >
                        {eur(c.difference)}
                      </td>
                      <td className="py-1.5 text-muted-foreground">{c.closedByName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular-nums">{eur(value)}</span>
    </div>
  );
}
