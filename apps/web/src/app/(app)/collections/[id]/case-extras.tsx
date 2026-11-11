'use client';

import {
  CASE_CHARGE_KINDS,
  CASE_CHARGE_LABELS,
  PICKUP_TIME_LABELS,
  type CaseChargeKind,
  type DelinquencyCaseDetailDto,
  type DelinquencyPickupDto,
} from '@storageos/shared';
import {
  CheckCircle2,
  CircleAlert,
  FileText,
  Loader2,
  Lock,
  PauseCircle,
  Receipt,
  Truck,
  Undo2,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { eur } from '../status';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
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
import { useHasPermission } from '@/lib/auth/hooks';
import { useCaseDocument, useCaseExtra } from '@/lib/collections/hooks';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';

type Case = DelinquencyCaseDetailDto;

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

/** Lo que pide atención en el expediente: pausa, candado por quitar, sobrante. */
export function CaseAlerts({ c }: { c: Case }) {
  const ask = useConfirm();
  const extra = useCaseExtra(c.id);
  const canManage = useHasPermission('collections:manage');
  const closed = c.status.startsWith('closed_');
  const overlockPending = !!c.overlockedAt && !c.overlockRemovedAt;
  const surplusPending = !!c.surplusCents && c.surplusCents > 0 && !c.surplusReturnedAt;

  async function removeOverlock() {
    const res = await ask({
      title: 'Quitar el candado',
      description: 'Queda constancia en el historial del expediente.',
      input: { label: 'Nota (opcional)', placeholder: 'Ej. pagó la primera cuota del plan' },
      confirmLabel: 'Ya lo he quitado',
    });
    if (!res) return;
    try {
      await extra.mutateAsync({
        action: 'remove-overlock',
        input: res.value ? { notes: res.value } : {},
      });
      toast.success('Candado quitado');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido registrar.'));
    }
  }

  async function surplusReturned() {
    const res = await ask({
      title: `Devolución de ${eur(c.surplusCents ?? 0)}`,
      description: 'Lo que sobró de la liquidación ya está devuelto al inquilino.',
      input: { label: 'Cómo se devolvió (opcional)', placeholder: 'Ej. transferencia el 12/11' },
      confirmLabel: 'Ya se ha devuelto',
    });
    if (!res) return;
    try {
      await extra.mutateAsync({
        action: 'surplus-returned',
        input: res.value ? { notes: res.value } : {},
      });
      toast.success('Devolución registrada');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido registrar.'));
    }
  }

  const items: React.ReactNode[] = [];
  if (c.pausedAt) {
    items.push(
      <Alert key="paused" tone="info" icon={<PauseCircle className="size-4" />}>
        <p>
          <strong>En pausa desde el {formatDate(c.pausedAt)}:</strong> tiene un plan de pagos al
          día. El expediente no avanza mientras lo cumpla; si lo incumple, sigue donde se quedó.
        </p>
        <Link
          href={`/customers/${c.customerId}`}
          className="text-xs font-medium underline-offset-2 hover:underline"
        >
          Ver su cuenta y el plan
        </Link>
      </Alert>,
    );
  }
  if (overlockPending && (closed || c.pausedAt)) {
    items.push(
      <Alert key="overlock" tone="warn" icon={<Lock className="size-4" />}>
        <p>
          <strong>Quita el candado:</strong>{' '}
          {closed
            ? 'el expediente está cerrado y sigue puesto desde el '
            : 'con el plan de pagos al día no debe seguir puesto. Está desde el '}
          {formatDate(c.overlockedAt)}.
        </p>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => void removeOverlock()}>
            Ya lo he quitado
          </Button>
        )}
      </Alert>,
    );
  }
  if (surplusPending) {
    items.push(
      <Alert key="surplus" tone="warn" icon={<Undo2 className="size-4" />}>
        <p>
          <strong>Devuélvele {eur(c.surplusCents ?? 0)}:</strong> es lo que sobró de la liquidación
          tras saldar la deuda.
        </p>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => void surplusReturned()}>
            Ya se ha devuelto
          </Button>
        )}
      </Alert>,
    );
  }
  if (overlockPending && !closed && !c.pausedAt && canManage) {
    items.push(
      <div key="overlock-quiet" className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-xs text-muted-foreground">
          Candado puesto el {formatDate(c.overlockedAt)}. Si llegáis a un acuerdo o retira sus
          bienes, quítalo y regístralo.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void removeOverlock()}>
          <Lock className="mr-1.5 size-4" /> He quitado el candado
        </Button>
      </div>,
    );
  }
  if (c.surplusReturnedAt && c.surplusCents) {
    items.push(
      <p key="surplus-done" className="px-1 text-xs text-muted-foreground">
        Sobrante de {eur(c.surplusCents)} devuelto el {formatDate(c.surplusReturnedAt)}.
      </p>,
    );
  }
  if (items.length === 0) return null;
  return <div className="space-y-2">{items}</div>;
}

function Alert({
  tone,
  icon,
  children,
}: {
  tone: 'info' | 'warn';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'info'
      ? 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200'
      : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200';
  return (
    <div className={`flex gap-3 rounded-lg border p-3 text-sm ${cls}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** Lo que conviene tener antes de enviar el requerimiento. */
export function NoticeChecklist({ c }: { c: Case }) {
  if (c.noticeChecklist.length === 0) return null;
  const blocking = c.noticeChecklist.filter((i) => i.blocking && !i.ok).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Antes del requerimiento</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <ul className="space-y-2">
          {c.noticeChecklist.map((i) => (
            <li key={i.key} className="flex gap-2">
              {i.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400" />
              ) : i.blocking ? (
                <XCircle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              )}
              <div>
                <div className={i.ok ? 'text-muted-foreground' : 'font-medium'}>{i.label}</div>
                {!i.ok && i.detail && (
                  <div className="text-xs text-muted-foreground">{i.detail}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
        {blocking > 0 && (
          <p className="text-xs text-red-600 dark:text-red-400">
            Sin esto no se puede generar el requerimiento.
          </p>
        )}
        {c.noticeChecklist.some((i) => i.key === 'address' && !i.ok) && (
          <Link
            href={`/customers/${c.customerId}`}
            className="text-xs font-medium underline-offset-2 hover:underline"
          >
            Completar sus datos
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/** Franjas de media hora para la cita (07:00 a 22:00). */
const SLOTS = Array.from({ length: 31 }, (_, k) => {
  const minutes = 7 * 60 + k * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 === 0 ? '00' : '30'}`;
});

const DEFAULT_WINDOW: Record<DelinquencyPickupDto['preferredTime'], [string, string]> = {
  morning: ['10:00', '13:00'],
  afternoon: ['16:00', '19:00'],
  any: ['10:00', '13:00'],
};

const PICKUP_STATUS: Record<DelinquencyPickupDto['status'], { label: string; cls: string }> = {
  pending: {
    label: 'Pendiente',
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  approved: {
    label: 'Concedida',
    cls: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  rejected: {
    label: 'Rechazada',
    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  },
  done: {
    label: 'Retirados',
    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  },
  cancelled: {
    label: 'Anulada',
    cls: 'bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400',
  },
};

/** Citas que pide el inquilino (desde su área de clientes) para retirar sus bienes. */
export function Pickups({ c }: { c: Case }) {
  if (c.pickups.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Citas para retirar sus bienes</CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        {c.pickups.map((p) => (
          <PickupRow key={p.id} c={c} p={p} />
        ))}
      </CardContent>
    </Card>
  );
}

function PickupRow({ c, p }: { c: Case; p: DelinquencyPickupDto }) {
  const ask = useConfirm();
  const extra = useCaseExtra(c.id);
  const canManage = useHasPermission('collections:manage');
  const [open, setOpen] = useState(false);
  const status = PICKUP_STATUS[p.status];

  async function reject() {
    const res = await ask({
      title: 'Rechazar la cita',
      description: 'Le llega un correo con el motivo y puede pedir otro día.',
      input: { label: 'Motivo', required: true, placeholder: 'Ej. ese día el local está cerrado' },
      confirmLabel: 'Rechazar',
      destructive: true,
    });
    if (!res || !res.value) return;
    try {
      await extra.mutateAsync({ action: `pickups/${p.id}/reject`, input: { reason: res.value } });
      toast.success('Cita rechazada');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido rechazar.'));
    }
  }

  async function done() {
    try {
      await extra.mutateAsync({ action: `pickups/${p.id}/done` });
      toast.success('Registrado: retiró sus bienes');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido registrar.'));
    }
  }

  return (
    <div className="space-y-2 py-3 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">
            Pide el {formatDate(p.preferredDate)} · {PICKUP_TIME_LABELS[p.preferredTime]}
          </span>
          <span className="ml-2 text-xs text-muted-foreground">
            (lo pidió el {formatDateTime(p.createdAt)})
          </span>
        </div>
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${status.cls}`}>
          {status.label}
        </span>
      </div>
      {p.note && <p className="text-muted-foreground">«{p.note}»</p>}
      {p.status === 'approved' && p.approvedFrom && p.approvedUntil && (
        <p>
          Concedida para el {formatDateTime(p.approvedFrom)} hasta las{' '}
          {new Date(p.approvedUntil).toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          .{' '}
          <span className="text-muted-foreground">
            {p.hasCode
              ? 'Tiene un código de un uso en su área de clientes.'
              : 'Sin código: le atiende alguien del equipo.'}
          </span>
        </p>
      )}
      {p.status === 'rejected' && p.resolutionNote && (
        <p className="text-muted-foreground">Motivo: {p.resolutionNote}</p>
      )}
      {canManage && p.status === 'pending' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setOpen(true)} disabled={extra.isPending}>
            Conceder la cita
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void reject()}
            disabled={extra.isPending}
          >
            Rechazar
          </Button>
        </div>
      )}
      {canManage && p.status === 'approved' && (
        <Button size="sm" variant="outline" onClick={() => void done()} disabled={extra.isPending}>
          <Truck className="mr-1.5 size-4" /> Ya ha retirado sus bienes
        </Button>
      )}
      {open && <ApprovePickupDialog c={c} p={p} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ApprovePickupDialog({
  c,
  p,
  onClose,
}: {
  c: Case;
  p: DelinquencyPickupDto;
  onClose: () => void;
}) {
  const extra = useCaseExtra(c.id);
  const [date, setDate] = useState<string | undefined>(p.preferredDate);
  const [from, setFrom] = useState(DEFAULT_WINDOW[p.preferredTime][0]);
  const [to, setTo] = useState(DEFAULT_WINDOW[p.preferredTime][1]);
  const [notes, setNotes] = useState('');
  const valid = !!date && from < to;

  async function submit() {
    if (!date) return;
    try {
      await extra.mutateAsync({
        action: `pickups/${p.id}/approve`,
        input: { date, from, to, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      });
      toast.success('Cita concedida: le llega un correo');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido conceder.'));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conceder la cita</DialogTitle>
          <DialogDescription>
            {c.goodsMovedAt
              ? `Sus bienes están en custodia${c.custodyLocation ? ` (${c.custodyLocation})` : ''}: alguien del equipo tendrá que atenderle.`
              : 'Si usas el control de accesos, recibe en su área de clientes un código que abre el local y su trastero una sola vez, en esa franja.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Día</Label>
            <DateSelect value={date} onChange={setDate} future />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Desde</Label>
              <Select value={from} onValueChange={setFrom}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLOTS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Hasta</Label>
              <Select value={to} onValueChange={setTo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLOTS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {from >= to && (
            <p className="text-xs text-red-600 dark:text-red-400">
              La hora de fin va después de la de inicio.
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="pickup-notes" className="text-xs">
              Nota para el inquilino (opcional)
            </Label>
            <Textarea
              id="pickup-notes"
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ej. trae una furgoneta: los bienes no caben en un coche"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || extra.isPending}>
            {extra.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Conceder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Gastos del traslado y la custodia, facturados al inquilino (condición 12). */
export function Charges({ c, isClosed }: { c: Case; isClosed: boolean }) {
  const extra = useCaseExtra(c.id);
  const [kind, setKind] = useState<CaseChargeKind>('transfer');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const value = Number(amount.replace(',', '.'));
  const valid = Number.isFinite(value) && value > 0 && value <= 100_000;
  if (isClosed && c.charges.length === 0) return null;

  async function submit() {
    try {
      const res = await extra.mutateAsync({
        action: 'charges',
        input: {
          kind,
          amount: Math.round(value * 100) / 100,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      });
      toast.success(`Factura ${res?.invoiceNumber ?? ''} emitida`);
      setAmount('');
      setDescription('');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido facturar.'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Gastos del expediente</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {c.charges.length > 0 ? (
          <ul className="divide-y">
            {c.charges.map((ch) => (
              <li
                key={ch.invoiceId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <Link href={`/invoices/${ch.invoiceId}`} className="font-medium hover:underline">
                  <Receipt className="mr-1 inline size-4" />
                  {ch.invoiceNumber}
                </Link>
                <span className="text-muted-foreground">{CASE_CHARGE_LABELS[ch.kind]}</span>
                <span className="font-semibold">{formatEur(ch.total)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            El traslado y la custodia de sus bienes son a su cargo. Se facturan aparte, con IVA.
          </p>
        )}
        {!isClosed && (
          <Can permission="collections:manage">
            <div className="flex flex-wrap items-end gap-2 border-t pt-3">
              <div className="space-y-1">
                <Label className="text-xs">Concepto</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as CaseChargeKind)}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CASE_CHARGE_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {CASE_CHARGE_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="charge-amount" className="text-xs">
                  Importe sin IVA (€)
                </Label>
                <Input
                  id="charge-amount"
                  inputMode="decimal"
                  className="w-32"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="min-w-48 flex-1 space-y-1">
                <Label htmlFor="charge-desc" className="text-xs">
                  Descripción (opcional)
                </Label>
                <Input
                  id="charge-desc"
                  maxLength={200}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ej. furgoneta y dos operarios"
                />
              </div>
              <Button size="sm" disabled={!valid || extra.isPending} onClick={() => void submit()}>
                Facturar
              </Button>
            </div>
          </Can>
        )}
      </CardContent>
    </Card>
  );
}

/** Documentos en PDF: acta del traslado, dossier y borrador de monitorio. */
export function Documents({ c }: { c: Case }) {
  const doc = useCaseDocument(c.id);
  const [actOpen, setActOpen] = useState(false);
  const canManage = useHasPermission('collections:manage');
  if (!canManage) return null;
  const resolved = !!c.contractResolvedAt;

  async function generate(
    body: Parameters<typeof doc.mutateAsync>[0],
    ok: string,
  ): Promise<boolean> {
    try {
      const { url } = await doc.mutateAsync(body);
      toast.success(ok, {
        duration: 15_000,
        action: { label: 'Abrir', onClick: () => window.open(url, '_blank', 'noopener') },
      });
      return true;
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido generar.'));
      return false;
    }
  }

  const busy = doc.isPending;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Documentos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void generate(
                { kind: 'dossier-pdf' },
                'Dossier generado y guardado en las evidencias.',
              )
            }
          >
            <FileText className="mr-1.5 size-4" /> Dossier del expediente
          </Button>
          {resolved && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setActOpen(true)}>
              <Truck className="mr-1.5 size-4" /> Acta del traslado
            </Button>
          )}
          {c.debtCents > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void generate(
                  { kind: 'monitorio-pdf' },
                  'Borrador de monitorio generado y guardado en las evidencias.',
                )
              }
            >
              <FileText className="mr-1.5 size-4" /> Borrador de monitorio
            </Button>
          )}
          {busy && <Loader2 className="size-4 animate-spin self-center text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground">
          El dossier reúne el contrato, las facturas, los avisos, el requerimiento, las fotos y el
          historial. El monitorio sirve para reclamar la deuda en el juzgado del domicilio del
          inquilino: hasta 2.000 € no hace falta abogado ni procurador. Revísalo antes de
          presentarlo.
        </p>
        {actOpen && (
          <CustodyActDialog
            c={c}
            busy={busy}
            onClose={() => setActOpen(false)}
            onSubmit={async (items, witnesses) => {
              const ok = await generate(
                {
                  kind: 'custody-act-pdf',
                  input: { items, ...(witnesses ? { witnesses } : {}) },
                },
                'Acta generada y guardada en las evidencias.',
              );
              if (ok) setActOpen(false);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function CustodyActDialog({
  c,
  busy,
  onClose,
  onSubmit,
}: {
  c: Case;
  busy: boolean;
  onClose: () => void;
  onSubmit: (items: string, witnesses: string) => Promise<void>;
}) {
  const [items, setItems] = useState('');
  const [witnesses, setWitnesses] = useState('');
  const lines = items.split('\n').filter((l) => l.trim()).length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Acta del traslado y la custodia</DialogTitle>
          <DialogDescription>
            El inventario de lo que se traslada{c.custodyLocation ? ` a ${c.custodyLocation}` : ''},
            una línea por bien o lote. Imprímela y fírmala con quien esté presente.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="act-items" className="text-xs">
              Inventario ({lines} {lines === 1 ? 'línea' : 'líneas'})
            </Label>
            <Textarea
              id="act-items"
              rows={8}
              maxLength={8000}
              value={items}
              onChange={(e) => setItems(e.target.value)}
              placeholder={
                'Sofá de tres plazas, gris\n6 cajas de cartón cerradas\nBicicleta de montaña'
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="act-witnesses" className="text-xs">
              Presentes en el traslado (opcional)
            </Label>
            <Input
              id="act-witnesses"
              maxLength={500}
              value={witnesses}
              onChange={(e) => setWitnesses(e.target.value)}
              placeholder="Ej. Luis Gómez (DNI 12345678Z)"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy || items.trim().length < 3}
            onClick={() => void onSubmit(items.trim(), witnesses.trim())}
          >
            {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Generar el acta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
