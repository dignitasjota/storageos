'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { CalendarEventDto, CalendarEventType } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCalendar } from '@/lib/calendar/hooks';

const TYPE_COLOR: Record<CalendarEventType, string> = {
  task: 'bg-blue-500',
  maintenance: 'bg-violet-500',
  contract_starting: 'bg-emerald-500',
  contract_ending: 'bg-amber-500',
  contract_renewing: 'bg-slate-400',
  reservation_expiring: 'bg-red-500',
  business_reminder: 'bg-cyan-600',
  price_change: 'bg-pink-500',
  invoice_due: 'bg-stone-700 dark:bg-stone-300',
  document_expiring: 'bg-lime-600',
};

const TYPE_LABEL: Record<CalendarEventType, string> = {
  task: 'Tarea',
  maintenance: 'Mantenimiento',
  contract_starting: 'Entrada',
  contract_ending: 'Fin de contrato',
  contract_renewing: 'Se prorroga',
  reservation_expiring: 'Fin de reserva',
  business_reminder: 'Vencimiento',
  price_change: 'Cambio de cuota',
  invoice_due: 'Factura que vence',
  document_expiring: 'Documento que caduca',
};

const HIDDEN_KEY = 'storageos.calendar.hidden';

function readHidden(): CalendarEventType[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY);
    return raw ? (JSON.parse(raw) as CalendarEventType[]) : [];
  } catch {
    return [];
  }
}

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Lunes (o el propio día) de la semana de `d`. */
function startOfWeekMonday(d: Date): Date {
  const r = new Date(d);
  const dow = (r.getDay() + 6) % 7; // 0 = lunes
  r.setDate(r.getDate() - dow);
  r.setHours(0, 0, 0, 0);
  return r;
}

export default function CalendarPage() {
  const qc = useQueryClient();
  const canMoveTasks = useHasPermission('tasks:write');
  const [mode, setMode] = useState<'month' | 'week'>('month');
  // Mes mostrado (primer día) y semana mostrada (lunes).
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [weekStart, setWeekStart] = useState(() => startOfWeekMonday(new Date()));
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Día abierto con «+N más».
  const [openDay, setOpenDay] = useState<string | null>(null);
  // Tipos ocultos (se recuerdan en este navegador) y alta rápida de tarea.
  const [hidden, setHidden] = useState<CalendarEventType[]>([]);
  const [newTaskDay, setNewTaskDay] = useState<string | null>(null);
  useEffect(() => setHidden(readHidden()), []);
  function toggleType(t: CalendarEventType) {
    setHidden((prev) => {
      const next = prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t];
      try {
        window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      } catch {
        /* sin almacenamiento */
      }
      return next;
    });
  }

  const firstOfMonth = cursor;
  const gridStart = mode === 'week' ? weekStart : startOfWeekMonday(firstOfMonth);
  // Mes: 6 semanas para cubrir cualquier mes. Semana: 7 días.
  const length = mode === 'week' ? 7 : 42;
  const days = useMemo(
    () =>
      Array.from({ length }, (_, i) => {
        const d = new Date(gridStart);
        d.setDate(d.getDate() + i);
        return d;
      }),
    [gridStart, length],
  );
  const from = ymd(days[0]!);
  const to = ymd(days[days.length - 1]!);

  // Arrastrar una tarea a otro día cambia su fecha.
  const moveTask = useMutation({
    mutationFn: ({ id, dueDate }: { id: string; dueDate: string }) =>
      apiFetch(`/tasks/${id}`, { method: 'PATCH', json: { dueDate } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      toast.success('Tarea movida.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'No se pudo mover'),
  });
  function onDrop(e: React.DragEvent, key: string) {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/task-id');
    const fromKey = e.dataTransfer.getData('text/task-day');
    if (id && fromKey !== key) moveTask.mutate({ id, dueDate: key });
  }

  const calendar = useCalendar(from, to);
  const { data } = calendar;

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEventDto[]>();
    for (const e of data?.events ?? []) {
      if (hidden.includes(e.type)) continue;
      const key = ymd(new Date(e.date));
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [data, hidden]);

  const monthLabel =
    mode === 'week'
      ? `${days[0]!.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} – ${days[6]!.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : firstOfMonth.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const todayKey = ymd(new Date());

  // Vista agenda (móvil): días del mes con eventos, en orden cronológico.
  const agenda = useMemo(
    () =>
      days
        .filter(
          (d) =>
            (mode === 'week' || d.getMonth() === firstOfMonth.getMonth()) &&
            (byDay.get(ymd(d)) ?? []).length,
        )
        .map((d) => ({ day: d, key: ymd(d), events: byDay.get(ymd(d)) ?? [] })),
    [days, firstOfMonth, byDay, mode],
  );

  function shift(delta: number) {
    if (mode === 'week') {
      setWeekStart((w) => {
        if (delta === 0) return startOfWeekMonday(new Date());
        const d = new Date(w);
        d.setDate(d.getDate() + delta * 7);
        return d;
      });
      return;
    }
    setCursor((c) =>
      delta === 0
        ? new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        : new Date(c.getFullYear(), c.getMonth() + delta, 1),
    );
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calendario</h1>
          <p className="text-sm text-muted-foreground">
            Tareas, mantenimientos y vencimientos de un vistazo.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            {(['month', 'week'] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? 'default' : 'ghost'}
                className="h-7"
                onClick={() => setMode(m)}
              >
                {m === 'month' ? 'Mes' : 'Semana'}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="icon" onClick={() => shift(-1)} aria-label="Anterior">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-40 text-center text-sm font-medium capitalize">{monthLabel}</span>
          <Button variant="outline" size="icon" onClick={() => shift(1)} aria-label="Siguiente">
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => shift(0)} className="ml-1">
            Hoy
          </Button>
        </div>
      </div>

      {canMoveTasks && (
        <p className="hidden text-xs text-muted-foreground md:block">
          Arrastra una tarea a otro día para cambiar su fecha.
        </p>
      )}

      {/* Leyenda: pulsar un tipo lo oculta o lo vuelve a enseñar. */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {(Object.keys(TYPE_LABEL) as CalendarEventType[]).map((t) => {
          const off = hidden.includes(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleType(t)}
              aria-pressed={!off}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-opacity ${
                off ? 'text-muted-foreground opacity-50 line-through' : 'text-foreground'
              }`}
            >
              <span className={`size-2.5 rounded-full ${TYPE_COLOR[t]}`} /> {TYPE_LABEL[t]}
            </button>
          );
        })}
        {canMoveTasks && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7"
            onClick={() => setNewTaskDay(ymd(new Date()))}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Nueva tarea
          </Button>
        )}
      </div>

      {calendar.isError && <SectionError onRetry={() => void calendar.refetch()} />}

      {/* Móvil: vista agenda (el grid de 7 columnas es ilegible en 360px). */}
      <div className="space-y-4 md:hidden">
        {agenda.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {mode === 'week'
              ? 'No hay nada programado esta semana.'
              : 'No hay nada programado este mes.'}
          </p>
        ) : (
          agenda.map(({ day, key, events }) => (
            <div key={key}>
              <p
                className={`text-sm font-medium capitalize ${key === todayKey ? 'text-primary' : ''}`}
              >
                {day.toLocaleDateString('es-ES', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
                {key === todayKey && ' · hoy'}
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {events.map((e) => (
                  <li key={`${e.type}-${e.id}`}>
                    <Link
                      href={e.href}
                      className="flex items-start gap-2 rounded-md border p-2.5 text-sm hover:bg-muted"
                    >
                      <span
                        className={`mt-1 size-2.5 shrink-0 rounded-full ${TYPE_COLOR[e.type]}`}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{e.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {TYPE_LABEL[e.type]}
                          {e.detail ? ` · ${e.detail}` : ''}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* Escritorio (md+): rejilla mensual. */}
      <Card className="hidden md:block">
        <CardContent className="p-2 sm:p-3">
          <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted-foreground">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const key = ymd(day);
              const inMonth = mode === 'week' || day.getMonth() === firstOfMonth.getMonth();
              const dayEvents = byDay.get(key) ?? [];
              const limit = mode === 'week' ? dayEvents.length : 4;
              return (
                <div
                  key={key}
                  onDragOver={(e) => {
                    if (!canMoveTasks) return;
                    e.preventDefault();
                    setDragOver(key);
                  }}
                  onDragLeave={() => setDragOver((k) => (k === key ? null : k))}
                  onDrop={(e) => onDrop(e, key)}
                  className={`${mode === 'week' ? 'min-h-72' : 'min-h-24'} rounded-md border p-1 ${inMonth ? '' : 'bg-muted/40'} ${key === todayKey ? 'border-primary' : 'border-border/60'} ${dragOver === key ? 'bg-primary/10' : ''}`}
                >
                  <div className="group flex items-center justify-between">
                    <span
                      className={`px-1 text-xs ${inMonth ? 'text-foreground' : 'text-muted-foreground'} ${key === todayKey ? 'font-semibold text-primary' : ''}`}
                    >
                      {day.getDate()}
                    </span>
                    {canMoveTasks && (
                      <button
                        type="button"
                        onClick={() => setNewTaskDay(key)}
                        aria-label={`Nueva tarea el ${day.getDate()}`}
                        className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {dayEvents.slice(0, limit).map((e) => (
                      <Link
                        key={`${e.type}-${e.id}`}
                        href={e.href}
                        draggable={canMoveTasks && e.type === 'task'}
                        onDragStart={(ev) => {
                          ev.dataTransfer.setData('text/task-id', e.id);
                          ev.dataTransfer.setData('text/task-day', key);
                        }}
                        title={`${TYPE_LABEL[e.type]}: ${e.label}${e.detail ? ` · ${e.detail}` : ''}`}
                        className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] hover:bg-muted"
                      >
                        <span className={`size-1.5 shrink-0 rounded-full ${TYPE_COLOR[e.type]}`} />
                        <span className="truncate">{e.label}</span>
                      </Link>
                    ))}
                    {dayEvents.length > limit && (
                      <button
                        type="button"
                        onClick={() => setOpenDay(key)}
                        className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        +{dayEvents.length - limit} más
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {newTaskDay && (
        <QuickTaskDialog
          day={newTaskDay}
          onClose={() => setNewTaskDay(null)}
          onDone={() => {
            setNewTaskDay(null);
            void qc.invalidateQueries({ queryKey: ['calendar'] });
            void qc.invalidateQueries({ queryKey: ['tasks'] });
          }}
        />
      )}

      <Dialog open={!!openDay} onOpenChange={(o) => !o && setOpenDay(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="capitalize">
              {openDay
                ? new Date(`${openDay}T12:00:00`).toLocaleDateString('es-ES', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })
                : ''}
            </DialogTitle>
          </DialogHeader>
          <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto">
            {(openDay ? (byDay.get(openDay) ?? []) : []).map((e) => (
              <li key={`${e.type}-${e.id}`}>
                <Link
                  href={e.href}
                  className="flex items-start gap-2 rounded-md border p-2.5 text-sm hover:bg-muted"
                >
                  <span className={`mt-1 size-2.5 shrink-0 rounded-full ${TYPE_COLOR[e.type]}`} />
                  <span className="min-w-0">
                    <span className="block font-medium">{e.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {TYPE_LABEL[e.type]}
                      {e.detail ? ` · ${e.detail}` : ''}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Alta rápida de una tarea para un día del calendario. */
function QuickTaskDialog({
  day,
  onClose,
  onDone,
}: {
  day: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(day);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) {
      toast.error('Escribe qué hay que hacer.');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/tasks', { method: 'POST', json: { title: title.trim(), dueDate: date } });
      toast.success('Tarea creada.');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Nueva tarea</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="quick-task-title">Qué hay que hacer</Label>
            <Input
              id="quick-task-title"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          </div>
          <div className="space-y-1">
            <Label>Para el</Label>
            <DateSelect around value={date} onChange={(v) => v && setDate(v)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
