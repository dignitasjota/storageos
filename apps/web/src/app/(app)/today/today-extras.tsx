'use client';

import { CalendarDays, CheckCircle2, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import type {
  TodayAttentionSectionDto,
  TodayDebtDto,
  TodayDoneDto,
  TodayExtrasDto,
  TodayTomorrowItemDto,
  TodayWeekItemDto,
} from '@storageos/shared';
import type { Clock } from 'lucide-react';

import { PhoneLinks, SnoozeMenu } from '@/components/dashboard/today-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
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
import { apiFetch, ApiError } from '@/lib/auth/api';
import { useUnsnoozeToday } from '@/lib/dashboard/hooks';
import { formatDate, formatEur } from '@/lib/format';

// Los usa también la página de «Hoy».
export { PhoneLinks, SnoozeMenu };

export function AttentionCard({
  title,
  icon: Icon,
  section,
  href,
}: {
  title: string;
  icon: typeof Clock;
  section: TodayAttentionSectionDto;
  href: string;
}) {
  if (section.count === 0) return null;
  const more = section.count - section.items.length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <Icon className="size-4 text-muted-foreground" />
            {title}
            <Badge variant="secondary">{section.count}</Badge>
          </span>
          <Link href={href} className="text-xs font-normal text-muted-foreground hover:underline">
            Ver todo
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {section.items.map((it) => (
            <li key={`${it.kind}-${it.refId}`} className="flex items-center gap-1">
              <Link
                href={it.href}
                className="flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
              >
                <span className="min-w-0 truncate">
                  {it.label}
                  {it.detail && <span className="text-muted-foreground"> · {it.detail}</span>}
                </span>
                {it.date && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(it.date)}
                  </span>
                )}
              </Link>
              <PhoneLinks phone={it.phone} />
              <SnoozeMenu kind={it.kind} refId={it.refId} label={it.label} />
            </li>
          ))}
          {more > 0 && (
            <li>
              <Link href={href} className="px-1 text-xs text-muted-foreground hover:underline">
                Y {more} más
              </Link>
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

function lastContact(iso: string | null): string {
  return iso ? `último contacto ${formatDate(iso)}` : 'sin contacto registrado';
}

/** La deuda por persona: a quién hay que llamar, no qué facturas hay. */
export function DebtsCard({
  debts,
  renderActions,
}: {
  debts: TodayExtrasDto['debts'];
  renderActions: (row: TodayDebtDto) => ReactNode;
}) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <Wallet className="size-4 text-muted-foreground" />
            Con deuda · {formatEur(debts.totalAmount)}
            <Badge variant="secondary">{debts.count}</Badge>
          </span>
          <Link
            href="/arrears"
            className="text-xs font-normal text-muted-foreground hover:underline"
          >
            Ver todo
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {debts.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nadie tiene deuda vencida.</p>
        ) : (
          <ul className="divide-y">
            {debts.rows.map((r) => (
              <li key={r.customerId} className="flex flex-wrap items-center gap-2 py-2">
                <Link
                  href={`/customers/${r.customerId}`}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <span className="block truncate text-sm font-medium">
                    {r.customerName} · {formatEur(r.amount)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.days} días · {r.invoiceCount} {r.invoiceCount === 1 ? 'factura' : 'facturas'}{' '}
                    · {lastContact(r.lastContactAt)}
                    {r.nextStep && ` · ${r.nextStep.label} el ${formatDate(r.nextStep.date)}`}
                  </span>
                </Link>
                {r.note && (
                  <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
                    {r.note}
                  </span>
                )}
                <PhoneLinks phone={r.phone} />
                {renderActions(r)}
                <SnoozeMenu kind="customer_debt" refId={r.customerId} label={r.customerName} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function TomorrowCard({ items }: { items: TodayTomorrowItemDto[] }) {
  if (items.length === 0) return null;
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <CalendarDays className="size-4 text-muted-foreground" />
          Mañana
          <Badge variant="secondary">{items.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={`${it.kind}-${it.id}`} className="flex flex-wrap items-center gap-2">
              <Link
                href={`/contracts/${it.id}`}
                className="min-w-0 flex-1 truncate rounded px-1 py-1 text-sm hover:bg-muted"
              >
                <span className="text-muted-foreground">
                  {it.kind === 'in' ? 'Entra' : 'Sale'} ·{' '}
                </span>
                {it.label}
                {it.detail && <span className="text-muted-foreground"> · {it.detail}</span>}
              </Link>
              {it.missing.length === 0 ? (
                <span className="text-xs text-emerald-700 dark:text-emerald-300">Todo listo</span>
              ) : (
                it.missing.map((m) => (
                  <span
                    key={m}
                    className="rounded bg-amber-100 px-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  >
                    Falta: {m}
                  </span>
                ))
              )}
              <PhoneLinks phone={it.phone} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const WEEK_LABELS: Record<TodayWeekItemDto['kind'], string> = {
  task: 'Tarea',
  followup: 'Seguimiento',
  lead_followup: 'Seguimiento',
  move_in: 'Entra',
  move_out: 'Sale',
  reminder: 'Vencimiento',
};

export function WeekList({ items }: { items: TodayWeekItemDto[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Nada previsto para los próximos 7 días.
        </CardContent>
      </Card>
    );
  }
  const days = [...new Set(items.map((i) => i.date.slice(0, 10)))];
  return (
    <div className="space-y-3">
      {days.map((day) => (
        <Card key={day}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{formatDate(day)}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {items
                .filter((i) => i.date.slice(0, 10) === day)
                .map((i) => (
                  <li key={`${i.kind}-${i.id}`}>
                    <Link
                      href={i.href}
                      className="block truncate rounded px-1 py-1 text-sm hover:bg-muted"
                    >
                      <span className="text-muted-foreground">{WEEK_LABELS[i.kind]} · </span>
                      {i.label}
                      {i.detail && <span className="text-muted-foreground"> · {i.detail}</span>}
                    </Link>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function DonePanel({ done }: { done: TodayDoneDto }) {
  const counters = [
    { label: 'Tareas', value: done.tasks },
    { label: 'Seguimientos', value: done.followups },
    { label: 'Contratos firmados', value: done.contractsSigned },
    { label: 'Contactos atendidos', value: done.leadsContacted },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {counters.map((c) => (
          <Card key={c.label}>
            <CardContent className="pt-6">
              <p className="text-2xl font-semibold tabular-nums">{c.value}</p>
              <p className="text-xs text-muted-foreground">{c.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-muted-foreground" />
              Cobrado hoy · {formatEur(done.collected)}
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href="/cash">{done.cashClosed ? 'Caja cerrada' : 'Cerrar la caja'}</Link>
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {done.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Hoy aún no hay cobros.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {done.payments.map((p) => (
                <li key={p.method} className="flex justify-between gap-2">
                  <span>
                    {p.label} <span className="text-muted-foreground">({p.count})</span>
                  </span>
                  <span className="tabular-nums">{formatEur(p.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function SnoozedList({ items }: { items: TodayExtrasDto['snoozed'] }) {
  const unsnooze = useUnsnoozeToday();
  if (items.length === 0) return null;
  return (
    <details className="rounded-lg border bg-card px-4 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">Apartados ({items.length})</summary>
      <ul className="mt-2 space-y-1">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {s.label ?? 'Aviso'}
              <span className="text-muted-foreground"> · hasta el {formatDate(s.until)}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={unsnooze.isPending}
              onClick={() => unsnooze.mutate(s.id)}
            >
              Recuperar
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

const PAY_METHODS = [
  ['cash', 'Efectivo'],
  ['card', 'Tarjeta (TPV)'],
  ['bank_transfer', 'Transferencia'],
  ['other', 'Otro'],
] as const;

/** Registrar a mano el cobro de una factura sin salir de «Hoy». */
export function ManualPaymentDialog({
  invoice,
  onClose,
  onDone,
}: {
  invoice: { id: string; amount: number; label: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [method, setMethod] = useState('cash');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!invoice) return;
    setSaving(true);
    try {
      await apiFetch(`/invoices/${invoice.id}/mark-paid`, {
        method: 'POST',
        json: { methodType: method, amount: invoice.amount },
      });
      toast.success('Pago registrado.');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={!!invoice} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar pago</DialogTitle>
        </DialogHeader>
        {invoice && (
          <div className="space-y-3">
            <p className="text-sm">
              {invoice.label} · {formatEur(invoice.amount)}
            </p>
            <div className="space-y-1">
              <Label>Forma de pago</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAY_METHODS.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Liquidar una fianza: lo que se devuelve y, si se retiene algo, por qué. */
export function SettleDepositDialog({
  deposit,
  onClose,
  onDone,
}: {
  deposit: { contractId: string; amount: number; label: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [returned, setReturned] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const amount = returned === '' ? (deposit?.amount ?? 0) : Number(returned.replace(',', '.'));
  const retains = !!deposit && amount < deposit.amount;
  const submit = async () => {
    if (!deposit) return;
    setSaving(true);
    try {
      await apiFetch(`/contracts/${deposit.contractId}/settle-deposit`, {
        method: 'POST',
        json: { returnedAmount: amount, ...(retains ? { retentionReason: reason } : {}) },
      });
      toast.success('Fianza liquidada.');
      setReturned('');
      setReason('');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={!!deposit} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Liquidar la fianza</DialogTitle>
        </DialogHeader>
        {deposit && (
          <div className="space-y-3">
            <p className="text-sm">
              {deposit.label} · fianza de {formatEur(deposit.amount)}
            </p>
            <div className="space-y-1">
              <Label htmlFor="today-settle-amount">Importe que se devuelve</Label>
              <Input
                id="today-settle-amount"
                inputMode="decimal"
                value={returned}
                placeholder={String(deposit.amount)}
                onChange={(e) => setReturned(e.target.value)}
              />
            </div>
            {retains && (
              <div className="space-y-1">
                <Label htmlFor="today-settle-reason">Motivo de la retención</Label>
                <Input
                  id="today-settle-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={saving || Number.isNaN(amount) || (retains && !reason.trim())}
            onClick={() => void submit()}
          >
            Liquidar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
