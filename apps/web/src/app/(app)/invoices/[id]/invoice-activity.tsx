'use client';

import {
  auditActionLabel,
  type InvoiceDto,
  type InvoiceHistoryRowDto,
  type InvoicePaymentRowDto,
  type SepaReturnCode,
} from '@storageos/shared';
import { Landmark, Loader2, Pencil, Undo2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { ReturnCodeSelect } from '@/components/billing/return-code-select';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  COMMUNICATION_STATUS_LABELS,
  DUNNING_STATUS_LABELS,
  DUNNING_STEP_LABELS,
  invoiceNoticeLabel,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  REFUND_VIA_LABELS,
} from '@/lib/billing/activity-labels';
import {
  useCorrectPayment,
  useInvoiceActivity,
  useMarkPaymentReturned,
  useUndoPayment,
} from '@/lib/billing/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';

/** Formas de pago que se pueden poner al corregir un cobro registrado a mano. */
const CORRECTABLE_METHODS = ['cash', 'bank_transfer', 'sepa_debit', 'card', 'other'] as const;
type CorrectableMethod = (typeof CORRECTABLE_METHODS)[number];

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function methodLabel(method: string | null): string {
  if (!method) return '';
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

/** Lo que cuenta cada entrada del historial, en palabras. */
function historyDetail(h: InvoiceHistoryRowDto): string | null {
  const c = h.changes ?? {};
  const text = (k: string): string | null =>
    typeof c[k] === 'string' && (c[k] as string).trim() ? (c[k] as string) : null;
  const amount = typeof c.amount === 'number' ? formatEur(c.amount) : null;
  switch (h.action) {
    case 'invoice.due_date_changed': {
      const from = text('from');
      const to = text('to');
      const reason = text('reason');
      const dates =
        from && to ? `Del ${formatDate(from)} al ${formatDate(to)}` : to ? formatDate(to) : null;
      return [dates, reason].filter(Boolean).join(' · ') || null;
    }
    case 'invoice.paid':
    case 'invoice.partial_payment': {
      const method = text('methodType');
      return [amount, method ? methodLabel(method) : null].filter(Boolean).join(' · ') || null;
    }
    case 'invoice.payment_reverted':
    case 'invoice.payment_undone':
    case 'invoice.refunded':
      return [amount, text('reason')].filter(Boolean).join(' · ') || null;
    case 'invoice.payment_corrected': {
      const from = c.from as { paidAt?: string | null; methodType?: string | null } | undefined;
      const to = c.to as { paidAt?: string | null; methodType?: string | null } | undefined;
      const parts: string[] = [];
      if (from?.paidAt && to?.paidAt && from.paidAt.slice(0, 10) !== to.paidAt.slice(0, 10)) {
        parts.push(`Fecha: ${formatDate(from.paidAt)} → ${formatDate(to.paidAt)}`);
      }
      if (from?.methodType && to?.methodType && from.methodType !== to.methodType) {
        parts.push(`Forma: ${methodLabel(from.methodType)} → ${methodLabel(to.methodType)}`);
      }
      return parts.join(' · ') || null;
    }
    case 'invoice.duplicated':
      return text('fromNumber') ? `Copia de la ${text('fromNumber')}` : null;
    case 'invoice.sent':
      return text('recipient') ? `A ${text('recipient')}` : null;
    case 'invoice.issued':
      return text('invoiceNumber') ? `Número ${text('invoiceNumber')}` : null;
    default:
      return text('reason');
  }
}

/** Cambiar la fecha o la forma de un cobro registrado a mano. */
function CorrectPaymentDialog({
  invoiceId,
  payment,
  onClose,
}: {
  invoiceId: string;
  payment: InvoicePaymentRowDto;
  onClose: () => void;
}) {
  const correct = useCorrectPayment();
  const initialDate = localDateString(new Date(payment.paidAt ?? payment.createdAt));
  const initialMethod = (CORRECTABLE_METHODS as readonly string[]).includes(payment.methodType)
    ? (payment.methodType as CorrectableMethod)
    : 'other';
  const [date, setDate] = useState<string | undefined>(initialDate);
  const [method, setMethod] = useState<CorrectableMethod>(initialMethod);
  const dateChanged = !!date && date !== initialDate;
  const methodChanged = method !== payment.methodType;

  async function save(): Promise<void> {
    if (!dateChanged && !methodChanged) return;
    const today = localDateString();
    try {
      await correct.mutateAsync({
        invoiceId,
        paymentId: payment.id,
        input: {
          // Hoy: la hora de ahora (no puede quedar en el futuro); otro día, a mediodía.
          ...(dateChanged && date
            ? {
                paidAt:
                  date === today
                    ? new Date().toISOString()
                    : new Date(`${date}T12:00:00`).toISOString(),
              }
            : {}),
          ...(methodChanged ? { methodType: method } : {}),
        },
      });
      toast.success('Cobro corregido.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido corregir.');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Corregir el cobro</DialogTitle>
          <DialogDescription>
            Cobro de {formatEur(payment.amount)}. Si el importe está mal, deshazlo y regístralo de
            nuevo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Fecha del cobro</Label>
            <DateSelect value={date} onChange={setDate} />
          </div>
          <div className="space-y-1">
            <Label>Forma de pago</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as CorrectableMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CORRECTABLE_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {methodLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={(!dateChanged && !methodChanged) || correct.isPending}
            onClick={() => void save()}
          >
            {correct.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Un cobro por banco que el banco devolvió (sin el extracto N43). */
function ReturnedPaymentDialog({
  invoiceId,
  payment,
  onClose,
}: {
  invoiceId: string;
  payment: InvoicePaymentRowDto;
  onClose: () => void;
}) {
  const mark = useMarkPaymentReturned();
  const [returnCode, setReturnCode] = useState<SepaReturnCode | null>(null);
  const [reason, setReason] = useState('');
  const [returnedOn, setReturnedOn] = useState(localDateString());

  async function submit() {
    try {
      await mark.mutateAsync({
        invoiceId,
        paymentId: payment.id,
        input: {
          ...(returnCode ? { returnCode } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          returnedOn,
        },
      });
      toast.success('Devolución registrada: la factura vuelve a estar pendiente.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>El banco devolvió el cobro</DialogTitle>
          <DialogDescription>
            {formatEur(payment.amount)} · {methodLabel(payment.methodType)}. El cobro deja de
            contar, la factura vuelve a estar pendiente y sale en Recibos devueltos.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Día de la devolución</Label>
            <DateSelect
              value={returnedOn}
              onChange={(v) => setReturnedOn(v ?? localDateString())}
            />
          </div>
          <div className="space-y-1">
            <Label>Código de devolución</Label>
            <ReturnCodeSelect value={returnCode} onChange={setReturnCode} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="returned-reason">Otro motivo (opcional)</Label>
            <Input
              id="returned-reason"
              maxLength={200}
              placeholder="Lo que diga el banco si no hay código"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button variant="destructive" disabled={mark.isPending} onClick={() => void submit()}>
            Registrar la devolución
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Un cobro que entró por el banco y sigue cobrado: el banco lo puede devolver. */
function bankReturnable(p: InvoicePaymentRowDto): boolean {
  return (
    !p.undone &&
    p.status === 'succeeded' &&
    p.gateway === 'manual' &&
    (p.methodType === 'bank_transfer' || p.methodType === 'sepa_debit')
  );
}

/**
 * Todo lo que ha pasado con la factura: cobros (con corregir y deshacer),
 * devoluciones, avisos enviados, pasos del escalado e historial.
 */
export function InvoiceActivityCard({ invoice }: { invoice: InvoiceDto }) {
  const ask = useConfirm();
  const activity = useInvoiceActivity(invoice.id);
  const undo = useUndoPayment();
  const canWrite = useHasPermission('invoices:write');
  const canManage = useHasPermission('invoices:manage');
  const [correcting, setCorrecting] = useState<InvoicePaymentRowDto | null>(null);
  const [returning, setReturning] = useState<InvoicePaymentRowDto | null>(null);

  async function handleUndo(p: InvoicePaymentRowDto): Promise<void> {
    const res = await ask({
      title: `¿Deshacer el cobro de ${formatEur(p.amount)}?`,
      description:
        'Para un cobro registrado por error: la factura vuelve a quedar pendiente y el cobro queda marcado como deshecho. No cuenta como un recibo devuelto.',
      confirmLabel: 'Deshacer el cobro',
      destructive: true,
      input: {
        label: 'Por qué',
        placeholder: 'Lo registré en la factura equivocada',
        required: true,
      },
    });
    if (!res) return;
    try {
      await undo.mutateAsync({ invoiceId: invoice.id, paymentId: p.id, reason: res.value.trim() });
      toast.success('Cobro deshecho: la factura vuelve a estar pendiente.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido deshacer.');
    }
  }

  const data = activity.data;
  const payments = data?.payments ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actividad</CardTitle>
      </CardHeader>
      <CardContent>
        {activity.isError ? (
          <SectionError onRetry={() => void activity.refetch()} />
        ) : !data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs defaultValue="payments">
            <TabsList>
              <TabsTrigger value="payments">Cobros · {payments.length}</TabsTrigger>
              <TabsTrigger value="refunds">Devoluciones · {data.refunds.length}</TabsTrigger>
              <TabsTrigger value="notices">Avisos · {data.communications.length}</TabsTrigger>
              <TabsTrigger value="dunning">Escalado · {data.dunning.length}</TabsTrigger>
              <TabsTrigger value="history">Historial</TabsTrigger>
            </TabsList>

            <TabsContent value="payments">
              {payments.length === 0 ? (
                <Empty>Aún no hay ningún cobro.</Empty>
              ) : (
                <ul className="divide-y">
                  {payments.map((p) => {
                    const status = PAYMENT_STATUS_LABELS[p.status];
                    return (
                      <li
                        key={p.id}
                        className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <p className="flex flex-wrap items-center gap-2">
                            <span
                              className={`font-medium tabular-nums ${p.undone ? 'line-through' : ''}`}
                            >
                              {formatEur(p.amount)}
                            </span>
                            <span className="text-muted-foreground">
                              {methodLabel(p.methodType)}
                            </span>
                            {p.undone ? (
                              <Badge variant="outline">Deshecho</Badge>
                            ) : (
                              status && <Badge variant={status.variant}>{status.label}</Badge>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDateTime(p.paidAt ?? p.createdAt)}
                            {p.notes && <> · {p.notes}</>}
                          </p>
                          {p.refundedAmount > 0 && (
                            <p className="text-xs text-muted-foreground">
                              Devuelto {formatEur(p.refundedAmount)}
                            </p>
                          )}
                          {p.returnedAt && !p.undone && (
                            <p className="text-xs text-destructive">
                              El banco lo devolvió el {formatDate(p.returnedAt)}
                              {p.failureReason && <> · {p.failureReason}</>}
                            </p>
                          )}
                          {p.status === 'failed' && p.failureReason && !p.returnedAt && (
                            <p className="text-xs text-destructive">{p.failureReason}</p>
                          )}
                        </div>
                        {(canWrite && p.editable) || (canManage && bankReturnable(p)) ? (
                          <div className="flex flex-wrap gap-1">
                            {canManage && bankReturnable(p) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setReturning(p)}
                                aria-label="El banco devolvió el cobro"
                              >
                                <Landmark className="mr-1 h-3.5 w-3.5" /> Devuelto por el banco
                              </Button>
                            )}
                            {canWrite && p.editable && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setCorrecting(p)}
                                  aria-label="Corregir el cobro"
                                >
                                  <Pencil className="mr-1 h-3.5 w-3.5" /> Corregir
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={undo.isPending}
                                  onClick={() => void handleUndo(p)}
                                  aria-label="Deshacer el cobro"
                                >
                                  <Undo2 className="mr-1 h-3.5 w-3.5" /> Deshacer
                                </Button>
                              </>
                            )}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="refunds">
              {data.refunds.length === 0 ? (
                <Empty>No se ha devuelto nada.</Empty>
              ) : (
                <ul className="divide-y">
                  {data.refunds.map((r) => (
                    <li key={r.id} className="space-y-0.5 py-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium tabular-nums">{formatEur(r.amount)}</span>
                        <span className="text-muted-foreground">
                          {REFUND_VIA_LABELS[r.via] ?? r.via}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(r.createdAt)}
                        {r.createdByName && <> · {r.createdByName}</>}
                        {r.paymentMethod && <> · cobrado en {methodLabel(r.paymentMethod)}</>}
                      </p>
                      {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="notices">
              {data.communications.length === 0 ? (
                <Empty>No se ha enviado ningún aviso de esta factura.</Empty>
              ) : (
                <ul className="divide-y">
                  {data.communications.map((c) => {
                    const status = COMMUNICATION_STATUS_LABELS[c.status];
                    return (
                      <li key={c.id} className="space-y-0.5 py-3 text-sm">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{invoiceNoticeLabel(c.source)}</span>
                          {status && <Badge variant={status.variant}>{status.label}</Badge>}
                          {c.channel !== 'email' && (
                            <Badge variant="outline">
                              {c.channel === 'whatsapp' ? 'WhatsApp' : c.channel}
                            </Badge>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(c.sentAt ?? c.createdAt)} · {c.recipient}
                        </p>
                        {c.subject && <p className="text-xs text-muted-foreground">{c.subject}</p>}
                        {c.errorMessage && (c.status === 'failed' || c.status === 'bounced') && (
                          <p className="text-xs text-destructive">{c.errorMessage}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="dunning">
              {data.dunning.length === 0 ? (
                <Empty>
                  {invoice.status === 'overdue'
                    ? 'El escalado aún no ha programado ningún paso.'
                    : 'No ha pasado por el escalado de impagos.'}
                </Empty>
              ) : (
                <ul className="divide-y">
                  {data.dunning.map((d) => {
                    const status =
                      d.status === 'superseded'
                        ? { label: 'Ya no aplica', variant: 'outline' as const }
                        : DUNNING_STATUS_LABELS[d.status];
                    return (
                      <li
                        key={d.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                      >
                        <div className="space-y-0.5">
                          <p className="font-medium">
                            {DUNNING_STEP_LABELS[d.actionType] ?? d.actionType}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {d.executedAt
                              ? `Hecho el ${formatDate(d.executedAt)}`
                              : `Previsto para el ${formatDate(d.scheduledFor)}`}
                            {d.notes && <> · {d.notes}</>}
                          </p>
                        </div>
                        {status && <Badge variant={status.variant}>{status.label}</Badge>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="history">
              {data.history.length === 0 ? (
                <Empty>Sin movimientos registrados.</Empty>
              ) : (
                <ul className="divide-y">
                  {data.history.map((h) => {
                    const detail = historyDetail(h);
                    return (
                      <li key={h.id} className="space-y-0.5 py-3 text-sm">
                        <p className="font-medium">{auditActionLabel(h.action)}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(h.createdAt)} · {h.userName ?? 'El sistema'}
                        </p>
                        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
      {correcting && (
        <CorrectPaymentDialog
          invoiceId={invoice.id}
          payment={correcting}
          onClose={() => setCorrecting(null)}
        />
      )}
      {returning && (
        <ReturnedPaymentDialog
          invoiceId={invoice.id}
          payment={returning}
          onClose={() => setReturning(null)}
        />
      )}
    </Card>
  );
}
