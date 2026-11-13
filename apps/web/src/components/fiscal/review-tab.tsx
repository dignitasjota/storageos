'use client';

import { AlertTriangle, CheckCircle2, Info, Lock, LockOpen, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { QuarterSelect, QueryState, YearSelect, eur, lastEndedQuarter } from './shared';

import type { FiscalCheckDto, FiscalClosureDto } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCloseQuarter,
  useFiscalChecks,
  useFiscalClosures,
  useReopenQuarter,
} from '@/lib/fiscal/hooks';
import { formatDateTime } from '@/lib/format';

const SEVERITY = {
  error: {
    icon: XCircle,
    className:
      'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
  },
  warning: {
    icon: AlertTriangle,
    className:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  },
  info: {
    icon: Info,
    className:
      'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200',
  },
} as const;

/** «Antes de presentar»: lo que conviene revisar del trimestre y su cierre. */
export function ReviewTab() {
  const initial = lastEndedQuarter();
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState(initial.quarter);
  const checks = useFiscalChecks(year, quarter);
  const d = checks.data;
  const pending = (d?.checks ?? []).filter((c) => c.count > 0);
  const ok = (d?.checks ?? []).filter((c) => c.count === 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="text-base">Antes de presentar</CardTitle>
              <CardDescription>
                Lo que conviene revisar antes de presentar los modelos del trimestre. Cuando esté
                presentado, ciérralo: sus cifras quedan guardadas y lo de ese periodo ya no se puede
                cambiar por error.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <YearSelect value={year} onChange={setYear} />
              <QuarterSelect value={quarter} onChange={setQuarter} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <QueryState query={checks} />
          {d && <ClosureBox year={year} quarter={quarter} ended={d.ended} closure={d.closure} />}
          {pending.map((c) => (
            <CheckBox key={c.key} check={c} />
          ))}
          {d && (
            <div className="rounded-md border p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-4" />
                {pending.length === 0 ? 'Todo en orden' : 'Sin problemas'}
              </div>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {ok.map((c) => (
                  <li key={c.key}>{c.title}: ninguno</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
      <ClosuresHistory />
    </div>
  );
}

function CheckBox({ check }: { check: FiscalCheckDto }) {
  const s = SEVERITY[check.severity];
  const Icon = s.icon;
  return (
    <div className={`rounded-md border p-3 text-sm ${s.className}`}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {check.title} ({check.count})
          </div>
          <p className="text-xs opacity-90">{check.detail}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {check.items.map((item, i) => (
              <li key={i} className="truncate">
                {item.href ? (
                  <Link href={item.href} className="underline underline-offset-2">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </li>
            ))}
            {check.count > check.items.length && (
              <li className="opacity-75">… y {check.count - check.items.length} más.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Figures({ closure }: { closure: FiscalClosureDto }) {
  const s = closure.snapshot;
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
      <div>
        <dt className="text-muted-foreground">IVA devengado</dt>
        <dd className="font-medium">{eur(s.vatAccrued)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">IVA deducible</dt>
        <dd className="font-medium">{eur(s.vatDeductible)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{s.result >= 0 ? 'A ingresar' : 'A compensar'}</dt>
        <dd className="font-medium">{eur(Math.abs(s.result))}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Retenciones (111 / 115)</dt>
        <dd className="font-medium">
          {eur(s.withholding111)} / {eur(s.withholding115)}
        </dd>
      </div>
    </dl>
  );
}

function ClosureBox({
  year,
  quarter,
  ended,
  closure,
}: {
  year: number;
  quarter: number;
  ended: boolean;
  closure: FiscalClosureDto | null;
}) {
  const close = useCloseQuarter();
  const confirm = useConfirm();
  const canReopen = useHasPermission('billing:configure');
  const [reopening, setReopening] = useState(false);

  async function onClose() {
    const okd = await confirm({
      title: `Cerrar el ${quarter}.º trimestre de ${year}`,
      description:
        'Se guardan sus cifras (IVA, retenciones, número de facturas y gastos) y, hasta que lo reabras, no se podrán crear, cambiar ni borrar gastos de ese trimestre ni anular por error sus facturas. Hazlo cuando ya lo hayas presentado.',
      confirmLabel: 'Cerrar el trimestre',
    });
    if (!okd) return;
    try {
      await close.mutateAsync({ year, quarter });
      toast.success('Trimestre cerrado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido cerrar.');
    }
  }

  if (closure) {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <Lock className="size-4" />
            Cerrado el {formatDateTime(closure.closedAt)}
            {closure.closedByName ? ` por ${closure.closedByName}` : ''}
          </div>
          {canReopen && (
            <Button size="sm" variant="outline" onClick={() => setReopening(true)}>
              <LockOpen className="mr-1 size-4" /> Reabrir
            </Button>
          )}
        </div>
        <Figures closure={closure} />
        <ReopenDialog closure={reopening ? closure : null} onClose={() => setReopening(false)} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <span className="text-muted-foreground">
        {ended
          ? 'Trimestre abierto: ciérralo cuando lo hayas presentado.'
          : 'El trimestre aún no ha terminado: se cierra cuando acabe.'}
      </span>
      <Button size="sm" onClick={() => void onClose()} disabled={!ended || close.isPending}>
        <Lock className="mr-1 size-4" /> Cerrar el trimestre
      </Button>
    </div>
  );
}

function ReopenDialog({
  closure,
  onClose,
}: {
  closure: FiscalClosureDto | null;
  onClose: () => void;
}) {
  const reopen = useReopenQuarter();
  const [reason, setReason] = useState('');
  async function submit() {
    if (!closure) return;
    try {
      await reopen.mutateAsync({ id: closure.id, reason });
      toast.success('Trimestre reabierto');
      setReason('');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido reabrir.');
    }
  }
  return (
    <Dialog open={!!closure} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Reabrir el {closure?.quarter}.º trimestre de {closure?.year}
          </DialogTitle>
          <DialogDescription>
            Se podrán volver a cambiar los gastos y las facturas de ese periodo. Si ya lo
            presentaste, lo que cambies puede obligar a una declaración complementaria.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="reopen-reason">Motivo</Label>
          <Textarea
            id="reopen-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Por ejemplo: faltaba la factura de la luz de septiembre"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={reason.trim().length < 3 || reopen.isPending}
          >
            Reabrir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClosuresHistory() {
  const closures = useFiscalClosures();
  const list = closures.data ?? [];
  if (closures.isSuccess && list.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Trimestres cerrados</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryState query={closures} />
        {list.length > 0 && (
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trimestre</TableHead>
                  <TableHead>Cerrado</TableHead>
                  <TableHead className="text-right">Resultado del IVA</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-sm">
                      {c.quarter}.º de {c.year}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(c.closedAt)}
                      {c.closedByName && (
                        <div className="text-muted-foreground">{c.closedByName}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {c.snapshot.result >= 0 ? 'A ingresar ' : 'A compensar '}
                      {eur(Math.abs(c.snapshot.result))}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.reopenedAt ? (
                        <>
                          Reabierto el {formatDateTime(c.reopenedAt)}
                          <div className="text-muted-foreground">{c.reopenReason}</div>
                        </>
                      ) : (
                        <span className="font-medium text-emerald-700 dark:text-emerald-400">
                          Cerrado
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
