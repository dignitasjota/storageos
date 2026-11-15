'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { FollowupInboxItemDto, FollowupInboxTab } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFollowupInbox } from '@/lib/followups/hooks';
import { useUsers } from '@/lib/users/hooks';

const TABS: { value: FollowupInboxTab; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'overdue', label: 'Atrasados' },
  { value: 'upcoming', label: 'Próximos' },
  { value: 'done', label: 'Hechos' },
];
const MINE_KEY = 'storageos.followups.mine';
const NONE = '__none';

function readMine(): boolean {
  try {
    return localStorage.getItem(MINE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Hoy (en la hora del navegador) + `days`, como YYYY-MM-DD. */
function dayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dueLabel(iso: string): { text: string; tone: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // La fecha es un día (YYYY-MM-DD): se lee en la hora local, no en UTC.
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const due = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const diff = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const text = due.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  if (diff < 0) return { text: `${text} (hace ${-diff} d)`, tone: 'text-red-600' };
  if (diff === 0) return { text: 'Hoy', tone: 'text-amber-600' };
  if (diff === 1) return { text: 'Mañana', tone: 'text-muted-foreground' };
  return { text, tone: 'text-muted-foreground' };
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

/** Rutas del seguimiento según sea de un inquilino o de un contacto. */
function urls(f: Pick<FollowupInboxItemDto, 'kind' | 'id' | 'targetId'>) {
  return f.kind === 'customer'
    ? {
        item: `/followups/${f.id}`,
        create: `/customers/${f.targetId}/followups`,
        target: `/customers/${f.targetId}`,
      }
    : {
        item: `/leads/followups/${f.id}`,
        create: `/leads/${f.targetId}/followups`,
        target: `/leads?lead=${f.targetId}`,
      };
}

function useFollowupApi() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['followups'] });
    void qc.invalidateQueries({ queryKey: ['leads', 'crm'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const update = useMutation({
    mutationFn: (args: { url: string; body: Record<string, unknown> }) =>
      apiFetch<unknown>(args.url, { method: 'PATCH', json: args.body }),
    onSuccess: refresh,
  });
  const create = useMutation({
    mutationFn: (args: { url: string; body: Record<string, unknown> }) =>
      apiFetch<unknown>(args.url, { method: 'POST', json: args.body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (url: string) => apiFetch<void>(url, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  return { update, create, remove };
}

export default function FollowupsPage() {
  const [tab, setTab] = useState<FollowupInboxTab>('today');
  const [mine, setMine] = useState(false);
  // Se recuerda en el navegador (tras montar, para no descuadrar el render del servidor).
  useEffect(() => setMine(readMine()), []);
  const { data, isLoading, isError, refetch } = useFollowupInbox(tab, mine);
  const canCustomers = useHasPermission('customers:write');
  const [creating, setCreating] = useState(false);
  const [doneOf, setDoneOf] = useState<FollowupInboxItemDto | null>(null);
  const [editOf, setEditOf] = useState<FollowupInboxItemDto | null>(null);

  const toggleMine = (v: boolean) => {
    setMine(v);
    try {
      localStorage.setItem(MINE_KEY, v ? '1' : '0');
    } catch {
      /* sin almacenamiento */
    }
  };

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Seguimientos</h1>
          <p className="text-sm text-muted-foreground">
            Los recordatorios del equipo sobre inquilinos y contactos: llamadas, renovaciones,
            presupuestos y visitas.
          </p>
        </div>
        {canCustomers && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" /> Nuevo seguimiento
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-full gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1 sm:w-auto">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors sm:px-3 ${
                tab === t.value
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
              {data && data.counts[t.value] > 0 && (
                <span
                  className={`ml-1.5 rounded-full px-1.5 text-xs ${
                    t.value === 'overdue'
                      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {data.counts[t.value]}
                </span>
              )}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <Checkbox checked={mine} onCheckedChange={(v) => toggleMine(v === true)} />
          Solo los míos
        </label>
      </div>

      <Card>
        <CardContent className="pt-4">
          {isError ? (
            <SectionError onRetry={() => void refetch()} />
          ) : isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (data?.items ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {tab === 'today'
                ? 'Nada para hoy. ✨'
                : tab === 'overdue'
                  ? 'No tienes nada atrasado.'
                  : tab === 'upcoming'
                    ? 'No hay seguimientos programados.'
                    : 'Aún no hay seguimientos hechos en los últimos 30 días.'}
            </p>
          ) : (
            <ul className="divide-y">
              {data!.items.map((f) => (
                <FollowupRow
                  key={`${f.kind}-${f.id}`}
                  f={f}
                  onDone={() => setDoneOf(f)}
                  onEdit={() => setEditOf(f)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {creating && <CreateFollowupDialog onClose={() => setCreating(false)} />}
      {doneOf && <DoneDialog f={doneOf} onClose={() => setDoneOf(null)} />}
      {editOf && <EditDialog f={editOf} onClose={() => setEditOf(null)} />}
    </div>
  );
}

function FollowupRow({
  f,
  onDone,
  onEdit,
}: {
  f: FollowupInboxItemDto;
  onDone: () => void;
  onEdit: () => void;
}) {
  const ask = useConfirm();
  const api = useFollowupApi();
  const canWrite = useHasPermission(f.kind === 'customer' ? 'customers:write' : 'leads:write');
  const u = urls(f);
  const due = dueLabel(f.dueDate);
  const done = f.status !== 'pending';

  const postpone = (days: number) =>
    api.update.mutate(
      { url: u.item, body: { dueDate: dayPlus(days) } },
      {
        onSuccess: () => toast.success('Pospuesto.'),
        onError: (err) => toast.error(errorText(err, 'No se ha podido posponer')),
      },
    );

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
        <p className={`text-sm font-medium ${done ? 'text-muted-foreground line-through' : ''}`}>
          {f.title}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          <Badge variant="outline" className="mr-1.5 px-1.5 py-0 text-[10px]">
            {f.kind === 'customer' ? 'Inquilino' : 'Contacto'}
          </Badge>
          <Link href={u.target} className="hover:underline">
            {f.targetName}
          </Link>
          {f.assignedToName ? ` · ${f.assignedToName}` : ''}
          {done && f.outcome ? ` · ${f.outcome}` : !done && f.note ? ` · ${f.note}` : ''}
        </p>
      </div>
      <span
        className={`mr-auto shrink-0 text-xs sm:mr-0 ${done ? 'text-muted-foreground' : due.tone}`}
      >
        {done && f.completedAt
          ? `Hecho el ${new Date(f.completedAt).toLocaleDateString('es-ES', {
              day: 'numeric',
              month: 'short',
            })}`
          : due.text}
      </span>
      {canWrite && (
        <div className="flex shrink-0 items-center gap-1">
          {!done ? (
            <Button size="sm" variant="outline" className="h-8" onClick={onDone}>
              <Check className="mr-1 size-4" /> Hecho
            </Button>
          ) : (
            f.status === 'done' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                onClick={() =>
                  api.update.mutate(
                    { url: u.item, body: { status: 'pending' } },
                    { onError: (err) => toast.error(errorText(err, 'No se ha podido reabrir')) },
                  )
                }
              >
                <RotateCcw className="mr-1 size-4" /> Reabrir
              </Button>
            )
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Más acciones">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!done && (
                <>
                  <DropdownMenuItem onClick={() => postpone(1)}>
                    <CalendarClock className="mr-2 size-4" /> Posponer a mañana
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => postpone(3)}>
                    <CalendarClock className="mr-2 size-4" /> Posponer 3 días
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => postpone(7)}>
                    <CalendarClock className="mr-2 size-4" /> Posponer una semana
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="mr-2 size-4" /> Editar
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={async () => {
                  if (
                    await ask({
                      title: '¿Borrar este seguimiento?',
                      description: f.title,
                      confirmLabel: 'Borrar',
                      destructive: true,
                    })
                  ) {
                    api.remove.mutate(u.item, {
                      onError: (err) => toast.error(errorText(err, 'No se ha podido borrar')),
                    });
                  }
                }}
              >
                <Trash2 className="mr-2 size-4" /> Borrar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

function UserSelect({
  value,
  onChange,
  id,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  id?: string;
}) {
  const users = useUsers();
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Sin responsable" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Quien lo crea</SelectItem>
        {(users.data ?? [])
          .filter((u) => u.isActive)
          .map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.fullName}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/** Marcarlo hecho con lo que pasó y, si hace falta, dejar el siguiente. */
function DoneDialog({ f, onClose }: { f: FollowupInboxItemDto; onClose: () => void }) {
  const api = useFollowupApi();
  const u = urls(f);
  const [outcome, setOutcome] = useState('');
  const [next, setNext] = useState(false);
  const [nextTitle, setNextTitle] = useState(f.title);
  const [nextDate, setNextDate] = useState(dayPlus(7));
  const busy = api.update.isPending || api.create.isPending;

  const save = async () => {
    try {
      await api.update.mutateAsync({
        url: u.item,
        body: { status: 'done', ...(outcome.trim() ? { outcome: outcome.trim() } : {}) },
      });
      if (next && nextTitle.trim().length >= 2) {
        await api.create.mutateAsync({
          url: u.create,
          body: {
            title: nextTitle.trim(),
            dueDate: nextDate,
            ...(f.assignedToUserId ? { assignedToUserId: f.assignedToUserId } : {}),
          },
        });
      }
      toast.success(next ? 'Hecho. Queda el siguiente programado.' : 'Hecho.');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido guardar'));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar hecho</DialogTitle>
          <DialogDescription>
            {f.title} · {f.targetName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fu-outcome">¿Qué ha pasado? (opcional)</Label>
            <Textarea
              id="fu-outcome"
              rows={3}
              maxLength={2000}
              placeholder="Le he llamado y quiere verlo el sábado…"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Queda en su ficha, en {f.kind === 'customer' ? 'Conversaciones' : 'Actividad'}.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={next} onCheckedChange={(v) => setNext(v === true)} />
            Crear el siguiente seguimiento
          </label>
          {next && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label htmlFor="fu-next-title">Qué hay que hacer</Label>
                <Input
                  id="fu-next-title"
                  value={nextTitle}
                  maxLength={200}
                  onChange={(e) => setNextTitle(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Para el</Label>
                <DateSelect
                  future
                  value={nextDate}
                  onChange={(v) => setNextDate(v ?? dayPlus(7))}
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 className="mr-1 size-4 animate-spin" />} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ f, onClose }: { f: FollowupInboxItemDto; onClose: () => void }) {
  const api = useFollowupApi();
  const u = urls(f);
  const [title, setTitle] = useState(f.title);
  const [note, setNote] = useState(f.note ?? '');
  const [dueDate, setDueDate] = useState(f.dueDate.slice(0, 10));
  const [assignee, setAssignee] = useState<string | null>(f.assignedToUserId);

  const save = () =>
    api.update.mutate(
      {
        url: u.item,
        body: {
          title: title.trim(),
          note: note.trim() || null,
          dueDate,
          assignedToUserId: assignee,
        },
      },
      {
        onSuccess: () => {
          toast.success('Guardado.');
          onClose();
        },
        onError: (err) => toast.error(errorText(err, 'No se ha podido guardar')),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar seguimiento</DialogTitle>
          <DialogDescription>{f.targetName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fu-title">Qué hay que hacer</Label>
            <Input
              id="fu-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fu-note">Nota</Label>
            <Textarea
              id="fu-note"
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Para el</Label>
              <DateSelect around value={dueDate} onChange={(v) => setDueDate(v ?? dueDate)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fu-assignee">Responsable</Label>
              <UserSelect id="fu-assignee" value={assignee} onChange={setAssignee} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={api.update.isPending || title.trim().length < 2}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Seguimiento nuevo sobre un inquilino (los de contactos, desde su ficha). */
function CreateFollowupDialog({ onClose }: { onClose: () => void }) {
  const api = useFollowupApi();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [dueDate, setDueDate] = useState(dayPlus(1));
  const [assignee, setAssignee] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);

  const save = () => {
    if (!customerId) return;
    api.create.mutate(
      {
        url: `/customers/${customerId}/followups`,
        body: {
          title: title.trim(),
          dueDate,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(assignee ? { assignedToUserId: assignee } : {}),
        },
      },
      {
        onSuccess: () => {
          toast.success('Seguimiento creado.');
          onClose();
        },
        onError: (err) => toast.error(errorText(err, 'No se ha podido crear')),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo seguimiento</DialogTitle>
          <DialogDescription>
            Sobre un inquilino. Los de un contacto se crean desde su ficha en Leads.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Inquilino</Label>
            <CustomerSearchSelect value={customerId} onChange={setCustomerId} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fu-new-title">Qué hay que hacer</Label>
            <Input
              id="fu-new-title"
              placeholder="Llamar para renovar"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Para el</Label>
            <DateSelect future value={dueDate} onChange={(v) => setDueDate(v ?? dayPlus(1))} />
          </div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowMore((v) => !v)}
          >
            <ChevronDown
              className={`size-3 transition-transform ${showMore ? 'rotate-180' : ''}`}
            />
            Nota y responsable
          </button>
          {showMore && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="fu-new-note">Nota</Label>
                <Textarea
                  id="fu-new-note"
                  rows={2}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fu-new-assignee">Responsable</Label>
                <UserSelect id="fu-new-assignee" value={assignee} onChange={setAssignee} />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={save}
            disabled={!customerId || title.trim().length < 2 || api.create.isPending}
          >
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
