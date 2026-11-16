'use client';

import {
  PLATFORM_LEAD_ACTIVITY_LABELS,
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_LOST_REASONS,
  PLATFORM_LEAD_MANUAL_STAGES,
  PLATFORM_LEAD_STAGE_LABELS,
  SALES_CADENCE_CHANNEL_LABELS,
  type PlatformLeadLostReason,
  type SalesAccountDto,
} from '@storageos/shared';
import { CheckCircle2, Circle, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  addDaysIso,
  errorText,
  Field,
  relativeDays,
  todayInSpain,
} from '@/components/admin/sales/common';
import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  useDeleteSalesFollowup,
  useSalesActivity,
  useSalesCadence,
  useSalesCadences,
  useSalesFollowup,
  useSalesLose,
  useSalesMove,
  useSalesReopen,
  useUpdateSalesFollowup,
} from '@/lib/admin/sales-hooks';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

export function FollowupsCard({ account }: { account: SalesAccountDto }) {
  const create = useSalesFollowup(account.lead.id);
  const update = useUpdateSalesFollowup();
  const remove = useDeleteSalesFollowup();
  const confirm = useConfirm();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(addDaysIso(todayInSpain(), 3));
  const followups = account.lead.followups;
  const pending = followups.filter((f) => f.status === 'pending');
  const done = followups.filter((f) => f.status !== 'pending').slice(0, 5);

  async function add() {
    try {
      await create.mutateAsync({ title: title.trim(), dueDate: date });
      setTitle('');
      toast.success('Seguimiento añadido.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Seguimientos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada pendiente.</p>
        ) : (
          <ul className="divide-y">
            {pending.map((f) => (
              <li key={f.id} className="flex items-start gap-2 py-2">
                <button
                  type="button"
                  aria-label="Marcar hecho"
                  className="mt-0.5 text-muted-foreground hover:text-emerald-600"
                  onClick={() =>
                    void update
                      .mutateAsync({ id: f.id, input: { status: 'done' } })
                      .catch((e) => toast.error(errorText(e)))
                  }
                >
                  <Circle className="size-4" />
                </button>
                <div className="min-w-0 flex-1 text-sm">
                  <p>{f.title}</p>
                  <p
                    className={cn(
                      'text-xs',
                      f.dueDate < todayInSpain()
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-muted-foreground',
                    )}
                  >
                    {formatDate(f.dueDate)} · {relativeDays(f.dueDate)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Borrar"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: 'Borrar este seguimiento',
                        confirmLabel: 'Borrar',
                        destructive: true,
                      }))
                    )
                      return;
                    remove.mutate(f.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2 rounded-md border p-2">
          <Input
            placeholder="Nuevo seguimiento (p. ej. «Llamar tras la demo»)"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DateSelect value={date} onChange={(v) => setDate(v ?? date)} future />
            <Button
              size="sm"
              disabled={title.trim().length < 2 || create.isPending}
              onClick={() => void add()}
            >
              Añadir
            </Button>
          </div>
        </div>
        {done.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Hechos recientemente
            </summary>
            <ul className="mt-1 space-y-1">
              {done.map((f) => (
                <li key={f.id} className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  {f.title}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

const MANUAL_TYPES = ['note', 'call', 'whatsapp', 'demo', 'meeting'] as const;

export function ActivityCard({ account }: { account: SalesAccountDto }) {
  const add = useSalesActivity(account.lead.id);
  const [type, setType] = useState<(typeof MANUAL_TYPES)[number]>('note');
  const [content, setContent] = useState('');

  async function submit() {
    try {
      await add.mutateAsync({ type, content: content.trim() });
      setContent('');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Historial</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2 rounded-md border p-2">
          <div className="flex gap-2">
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {PLATFORM_LEAD_ACTIVITY_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="ml-auto"
              disabled={!content.trim() || add.isPending}
              onClick={() => void submit()}
            >
              Anotar
            </Button>
          </div>
          <Textarea
            rows={2}
            placeholder="Qué ha pasado"
            value={content}
            maxLength={4000}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
        {account.lead.activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay nada anotado.</p>
        ) : (
          <ol className="space-y-3">
            {account.lead.activities.slice(0, 40).map((a) => (
              <li key={a.id} className="border-l-2 pl-3 text-sm">
                <p className="text-xs text-muted-foreground">
                  {PLATFORM_LEAD_ACTIVITY_LABELS[a.type] ?? a.type} · {formatDateTime(a.occurredAt)}
                  {a.superAdminName && ` · ${a.superAdminName}`}
                </p>
                {a.subject && <p className="font-medium">{a.subject}</p>}
                <p className="whitespace-pre-line break-words">{a.content}</p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

export function OffersCard({ account }: { account: SalesAccountDto }) {
  const offers = account.lead.quoteOffers;
  if (offers.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Propuestas</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {offers.map((o) => (
            <li key={o.id} className="flex items-start justify-between gap-2 py-2">
              <div>
                <p className="font-medium">
                  {o.planName} · {formatEur(o.total)} {o.cycle === 'yearly' ? 'al año' : 'al mes'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Enviada {formatDate(o.createdAt)}
                  {o.couponCode && ` · cupón ${o.couponCode}`}
                  {o.openedAt
                    ? ` · la abrió ${relativeDays(o.openedAt)}`
                    : ' · aún no la ha abierto'}
                </p>
              </div>
              <Badge variant={o.status === 'accepted' ? 'default' : 'outline'}>
                {o.status === 'accepted'
                  ? 'Aceptada'
                  : o.status === 'rejected'
                    ? 'Rechazada'
                    : o.expired
                      ? 'Caducada'
                      : 'Pendiente'}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function CadenceCard({ account }: { account: SalesAccountDto }) {
  const cadences = useSalesCadences();
  const run = useSalesCadence(account.lead.id);
  const [cadenceId, setCadenceId] = useState('');
  const current = account.cadence?.status === 'active' ? account.cadence : null;

  async function go(id: string | null) {
    try {
      await run.mutateAsync({ cadenceId: id });
      toast.success(
        id ? 'Cadencia en marcha: tienes sus pasos en tus seguimientos.' : 'Cadencia parada.',
      );
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Cadencia</CardTitle>
        <CardDescription>Una serie de contactos con sus fechas, ya en tu agenda.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {current ? (
          <>
            <p className="font-medium">{current.cadenceName}</p>
            <ul className="space-y-1">
              {current.steps.map((s) => (
                <li key={s.followupId} className="flex items-center gap-2">
                  {s.done ? (
                    <CheckCircle2 className="size-4 text-emerald-600" />
                  ) : (
                    <Circle className="size-4 text-muted-foreground" />
                  )}
                  <span className={s.done ? 'text-muted-foreground line-through' : ''}>
                    {s.title}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDate(s.dueDate)}
                  </span>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="outline"
              disabled={run.isPending}
              onClick={() => void go(null)}
            >
              Parar la cadencia
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={cadenceId} onValueChange={setCadenceId}>
              <SelectTrigger className="w-60">
                <SelectValue placeholder="Elige una cadencia" />
              </SelectTrigger>
              <SelectContent>
                {(cadences.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({c.steps.length} pasos)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!cadenceId || run.isPending}
              onClick={() => void go(cadenceId)}
            >
              Empezar
            </Button>
            {cadenceId && (
              <ul className="w-full space-y-0.5 text-xs text-muted-foreground">
                {cadences.data
                  ?.find((c) => c.id === cadenceId)
                  ?.steps.map((s, i) => (
                    <li key={i}>
                      Día {s.day} · {SALES_CADENCE_CHANNEL_LABELS[s.channel]} · {s.title}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LoseDialog({ account, onClose }: { account: SalesAccountDto; onClose: () => void }) {
  const lose = useSalesLose(account.lead.id);
  const [reasonCode, setReasonCode] = useState<PlatformLeadLostReason | ''>('');
  const [reason, setReason] = useState('');
  const [recontactOn, setRecontactOn] = useState('');

  async function submit() {
    if (!reasonCode) return;
    try {
      await lose.mutateAsync({ reasonCode, reason, recontactOn });
      toast.success('Marcado como perdido.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Marcar como perdido</DialogTitle>
          <DialogDescription>
            Queda en tu cartera por si vuelve; puedes reabrirlo cuando quieras.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Motivo">
            <Select
              value={reasonCode}
              onValueChange={(v) => setReasonCode(v as PlatformLeadLostReason)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Elige el motivo" />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_LEAD_LOST_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {PLATFORM_LEAD_LOST_REASON_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="lo-reason" label="Detalle (opcional)">
            <Textarea
              id="lo-reason"
              rows={2}
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Field label="Volver a contactar (opcional)">
            <div className="flex items-center gap-2">
              <DateSelect
                value={recontactOn || undefined}
                onChange={(v) => setRecontactOn(v ?? '')}
                future
              />
              {recontactOn && (
                <Button size="sm" variant="ghost" onClick={() => setRecontactOn('')}>
                  Quitar
                </Button>
              )}
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!reasonCode || lose.isPending}
            onClick={() => void submit()}
          >
            {lose.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Marcar perdido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Fase del prospecto (las de prueba y cliente las marca su cuenta). */
export function StageCard({ account }: { account: SalesAccountDto }) {
  const move = useSalesMove(account.lead.id);
  const reopen = useSalesReopen(account.lead.id);
  const [loseOpen, setLoseOpen] = useState(false);
  const status = account.lead.status;
  const manual = (PLATFORM_LEAD_MANUAL_STAGES as readonly string[]).includes(status);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Fase: {PLATFORM_LEAD_STAGE_LABELS[status]}</CardTitle>
        {!manual && status !== 'lost' && (
          <CardDescription>Esta fase la marca su cuenta (prueba o pago).</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {status === 'lost' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={reopen.isPending}
            onClick={() =>
              void reopen.mutateAsync(undefined).catch((e) => toast.error(errorText(e)))
            }
          >
            Reabrir
          </Button>
        ) : (
          <>
            {manual &&
              PLATFORM_LEAD_MANUAL_STAGES.filter((s) => s !== status).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="outline"
                  disabled={move.isPending}
                  onClick={() =>
                    void move.mutateAsync({ status: s }).catch((e) => toast.error(errorText(e)))
                  }
                >
                  Pasar a {PLATFORM_LEAD_STAGE_LABELS[s].toLowerCase()}
                </Button>
              ))}
            {status !== 'customer' && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => setLoseOpen(true)}
              >
                Perdido
              </Button>
            )}
          </>
        )}
      </CardContent>
      {loseOpen && <LoseDialog account={account} onClose={() => setLoseOpen(false)} />}
    </Card>
  );
}
