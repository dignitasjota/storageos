'use client';

import {
  SEO_TASK_BOARD_STATUSES,
  SEO_TASK_PRIORITY_LABELS,
  SEO_TASK_STATUSES,
  SEO_TASK_STATUS_LABELS,
  SEO_TASK_TYPES,
  SEO_TASK_TYPE_LABELS,
  seoTaskDate,
  seoTaskDueState,
  type SeoTaskDto,
  type SeoTaskStatus,
  type SeoTaskType,
} from '@storageos/shared';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  KanbanSquare,
  List,
  Loader2,
  Plus,
  User,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { type ChangeDraft, type PlanDomain, TaskDialog } from './plan-dialogs';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDate } from '@/lib/format';
import { useOpportunityAssignees } from '@/lib/seo-advanced/opportunity-hooks';
import {
  type PlanScope,
  type TaskFilters,
  saveCsv,
  seoTasksCsv,
  useMoveSeoTask,
  useSeoTasks,
} from '@/lib/seo-advanced/plan-hooks';
import { cn } from '@/lib/utils';

const ALL = '__all__';
type View = 'board' | 'calendar' | 'list';

const DUE_STYLE = {
  overdue: 'text-red-700 dark:text-red-400',
  today: 'text-amber-700 dark:text-amber-400',
  soon: 'text-foreground',
} as const;

function DueText({ task, today }: { task: SeoTaskDto; today: string }) {
  const date = seoTaskDate(task);
  if (!date) return null;
  const state = seoTaskDueState(task, today);
  const label = task.dueDate ? 'Para el' : 'Se publica el';
  return (
    <span className={cn('text-xs', state ? DUE_STYLE[state] : 'text-muted-foreground')}>
      {state === 'overdue' ? 'Atrasada · ' : state === 'today' ? 'Hoy · ' : ''}
      {label} {formatDate(date)}
    </span>
  );
}

function TaskCard({
  task,
  today,
  canEdit,
  onOpen,
  onDragStart,
  onStatus,
}: {
  task: SeoTaskDto;
  today: string;
  canEdit: boolean;
  onOpen: () => void;
  onDragStart?: () => void;
  onStatus?: (s: SeoTaskStatus) => void;
}) {
  return (
    <div
      draggable={canEdit && !!onDragStart}
      onDragStart={onDragStart}
      className={cn(
        'rounded-md border bg-card p-3 text-sm shadow-sm hover:shadow-md',
        canEdit && onDragStart && 'md:cursor-grab',
      )}
    >
      <button type="button" onClick={onOpen} className="w-full text-left">
        <span className="block break-words font-medium">{task.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <Badge variant="outline" className="font-normal">
            {SEO_TASK_TYPE_LABELS[task.type]}
          </Badge>
          {task.priority === 'high' && (
            <Badge variant="secondary" className="font-normal">
              Prioridad {SEO_TASK_PRIORITY_LABELS.high.toLowerCase()}
            </Badge>
          )}
          {task.changeId && (
            <Badge variant="secondary" className="font-normal">
              Actuación registrada
            </Badge>
          )}
        </span>
        {task.sourceLabel && (
          <span className="mt-1 block break-words text-xs text-muted-foreground">
            {task.sourceLabel}
          </span>
        )}
        <span className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
          <DueText task={task} today={today} />
          {task.assignedToName && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <User className="size-3" aria-hidden /> {task.assignedToName}
            </span>
          )}
        </span>
      </button>
      {/* En el móvil no se arrastra: se cambia de columna aquí. */}
      {canEdit && onStatus && (
        <div className="mt-2 md:hidden">
          <Select value={task.status} onValueChange={(v) => onStatus(v as SeoTaskStatus)}>
            <SelectTrigger className="h-8" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEO_TASK_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SEO_TASK_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tablero

function Board({
  tasks,
  today,
  canEdit,
  onOpen,
  onMove,
}: {
  tasks: SeoTaskDto[];
  today: string;
  canEdit: boolean;
  onOpen: (t: SeoTaskDto) => void;
  onMove: (t: SeoTaskDto, status: SeoTaskStatus, index: number) => void;
}) {
  const [dragging, setDragging] = useState<SeoTaskDto | null>(null);
  const columns = SEO_TASK_BOARD_STATUSES.map((status) => ({
    status,
    items: tasks.filter((t) => t.status === status).sort((a, b) => a.position - b.position),
  }));
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const drop = (status: SeoTaskStatus, index: number) => {
    if (!dragging) return;
    onMove(dragging, status, index);
    setDragging(null);
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((col) => (
          <section
            key={col.status}
            aria-label={SEO_TASK_STATUS_LABELS[col.status]}
            className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-2"
            onDragOver={(e) => canEdit && e.preventDefault()}
            onDrop={() => drop(col.status, col.items.length)}
          >
            <h3 className="flex items-center justify-between px-1 text-sm font-medium">
              {SEO_TASK_STATUS_LABELS[col.status]}
              <span className="text-xs font-normal text-muted-foreground">{col.items.length}</span>
            </h3>
            {col.items.length === 0 && (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">Sin tareas</p>
            )}
            {col.items.map((t, i) => (
              <div
                key={t.id}
                onDragOver={(e) => canEdit && e.preventDefault()}
                onDrop={(e) => {
                  e.stopPropagation();
                  drop(col.status, i);
                }}
              >
                <TaskCard
                  task={t}
                  today={today}
                  canEdit={canEdit}
                  onOpen={() => onOpen(t)}
                  onDragStart={() => setDragging(t)}
                  onStatus={(s) => onMove(t, s, Number.MAX_SAFE_INTEGER)}
                />
              </div>
            ))}
          </section>
        ))}
      </div>
      {cancelled > 0 && (
        <p className="text-xs text-muted-foreground">
          {cancelled} {cancelled === 1 ? 'cancelada' : 'canceladas'}: en la vista de lista.
        </p>
      )}
    </div>
  );
}

// -------------------------------------------------------------- calendario

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Primer y último día que salen en la rejilla del mes (de lunes a domingo). */
export function monthGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const last = new Date(year, month + 1, 0);
  const end = new Date(last);
  end.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
  const days: string[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  return { from: days[0]!, to: days[days.length - 1]!, days };
}

function Calendar({
  scope,
  filters,
  canEdit,
  onOpen,
}: {
  scope: PlanScope;
  filters: TaskFilters;
  canEdit: boolean;
  onOpen: (t: SeoTaskDto) => void;
}) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const grid = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  const tasks = useSeoTasks(scope, { ...filters, from: grid.from, to: grid.to });
  const byDay = useMemo(() => {
    const map = new Map<string, SeoTaskDto[]>();
    for (const t of tasks.data?.items ?? []) {
      const d = seoTaskDate(t);
      if (!d) continue;
      map.set(d, [...(map.get(d) ?? []), t]);
    }
    return map;
  }, [tasks.data]);
  const today = tasks.data?.today ?? ymd(now);
  const monthPrefix = `${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}`;
  const agenda = grid.days.filter((d) => d.startsWith(monthPrefix) && byDay.has(d));
  const shift = (n: number) =>
    setCursor(({ y, m }) => {
      const d = new Date(y, m + n, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="icon" aria-label="Mes anterior" onClick={() => shift(-1)}>
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <p className="text-sm font-medium capitalize">
          {MONTHS[cursor.m]} {cursor.y}
        </p>
        <Button variant="outline" size="icon" aria-label="Mes siguiente" onClick={() => shift(1)}>
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Cada tarea sale el día de su fecha límite o, en las de contenido sin fecha límite, el de su
        publicación{canEdit ? '. Púlsala para cambiarla.' : '.'}
      </p>
      {tasks.isError ? (
        <SectionError onRetry={() => void tasks.refetch()} />
      ) : tasks.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Móvil: agenda (la rejilla de 7 columnas no se lee en 360 px). */}
          <div className="space-y-3 md:hidden">
            {agenda.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nada con fecha este mes.
              </p>
            ) : (
              agenda.map((d) => (
                <div key={d} className="space-y-1">
                  <p className={cn('text-xs font-medium', d === today && 'text-primary')}>
                    {formatDate(d)}
                  </p>
                  {byDay.get(d)!.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      today={today}
                      canEdit={false}
                      onOpen={() => onOpen(t)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
          <div className="hidden md:block">
            <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted-foreground">
              {WEEKDAYS.map((w) => (
                <div key={w} className="py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {grid.days.map((d) => {
                const items = byDay.get(d) ?? [];
                const inMonth = d.startsWith(monthPrefix);
                return (
                  <div
                    key={d}
                    className={cn(
                      'min-h-24 rounded-md border p-1 text-xs',
                      !inMonth && 'bg-muted/40 text-muted-foreground',
                      d === today && 'border-primary',
                    )}
                  >
                    <p className="mb-1 text-right tabular-nums">{Number(d.slice(8))}</p>
                    <ul className="space-y-1">
                      {items.slice(0, 3).map((t) => {
                        const state = seoTaskDueState(t, today);
                        return (
                          <li key={t.id}>
                            <button
                              type="button"
                              onClick={() => onOpen(t)}
                              title={t.title}
                              className={cn(
                                'w-full truncate rounded px-1 py-0.5 text-left',
                                t.status === 'done' || t.status === 'cancelled'
                                  ? 'bg-muted text-muted-foreground line-through'
                                  : state === 'overdue'
                                    ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                                    : 'bg-primary/10 text-foreground',
                              )}
                            >
                              {t.dueDate ? '' : '✎ '}
                              {t.title}
                            </button>
                          </li>
                        );
                      })}
                      {items.length > 3 && (
                        <li className="px-1 text-muted-foreground">y {items.length - 3} más</li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">✎ = fecha de publicación.</p>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ lista

function TaskList({
  tasks,
  today,
  onOpen,
}: {
  tasks: SeoTaskDto[];
  today: string;
  onOpen: (t: SeoTaskDto) => void;
}) {
  if (tasks.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Sin tareas.</p>;
  }
  return (
    <ul className="divide-y rounded-md border">
      {tasks.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => onOpen(t)}
            className="flex w-full flex-col gap-1 p-3 text-left hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="min-w-0">
              <span className="block break-words text-sm font-medium">{t.title}</span>
              <span className="text-xs text-muted-foreground">
                {SEO_TASK_TYPE_LABELS[t.type]} · {SEO_TASK_PRIORITY_LABELS[t.priority]}
                {t.assignedToName ? ` · ${t.assignedToName}` : ''}
              </span>
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-2">
              <DueText task={t} today={today} />
              <Badge variant={t.status === 'done' ? 'secondary' : 'outline'}>
                {SEO_TASK_STATUS_LABELS[t.status]}
              </Badge>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ panel

/**
 * Tareas SEO: tablero por estado (arrastrar y soltar; en el móvil, un
 * desplegable en cada tarjeta), calendario mensual por fecha límite o de
 * publicación y lista, con filtros por tipo y responsable y «Mis tareas».
 * Al pasar una a «hecha» se ofrece registrar la actuación.
 */
export function SeoTasksPanel({
  scope,
  canEdit,
  domains,
  onRecordChange,
}: {
  scope: PlanScope;
  canEdit: boolean;
  domains: PlanDomain[];
  onRecordChange: (draft: ChangeDraft) => void;
}) {
  const [view, setView] = useState<View>('board');
  const [type, setType] = useState<SeoTaskType | null>(null);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<SeoTaskDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const assignees = useOpportunityAssignees(scope, true);
  const filters: TaskFilters = { type, assignedTo, search };
  const tasks = useSeoTasks(scope, filters);
  const move = useMoveSeoTask(scope);
  const items = tasks.data?.items ?? [];
  const today = tasks.data?.today ?? '';

  const onMove = async (t: SeoTaskDto, status: SeoTaskStatus, index: number) => {
    const column = items.filter((x) => x.status === status && x.id !== t.id).length;
    try {
      await move.mutateAsync({
        id: t.id,
        input: { status, index: Math.min(index, column) },
      });
      if (status === 'done' && t.status !== 'done' && !t.changeId) {
        toast.success('Tarea hecha', {
          description: '¿Registras el cambio para ver su antes y después?',
          action: {
            label: 'Registrar la actuación',
            onClick: () =>
              onRecordChange({
                title: t.title,
                type: t.type === 'technical' ? 'technical' : 'content',
                urls: t.url ? [t.url] : [],
                keywords: t.keywords,
                domainId: t.domainId,
                taskId: t.id,
                opportunityId: t.opportunityId,
                cannibalizationId: t.cannibalizationId,
                indexFindingId: t.indexFindingId,
              }),
          },
          duration: 10_000,
        });
      }
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const csv = async () => {
    setDownloading(true);
    try {
      saveCsv(await seoTasksCsv(scope, filters), 'tareas-seo.csv');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const VIEWS: { v: View; label: string; Icon: typeof List }[] = [
    { v: 'board', label: 'Tablero', Icon: KanbanSquare },
    { v: 'calendar', label: 'Calendario', Icon: CalendarDays },
    { v: 'list', label: 'Lista', Icon: List },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Vista">
          {VIEWS.map(({ v, label, Icon }) => (
            <Button
              key={v}
              size="sm"
              variant={view === v ? 'secondary' : 'ghost'}
              className="h-7 px-2"
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              <Icon className="mr-1 size-3.5" aria-hidden /> {label}
            </Button>
          ))}
        </div>
        <Select
          value={type ?? ALL}
          onValueChange={(v) => setType(v === ALL ? null : (v as SeoTaskType))}
        >
          <SelectTrigger className="h-8 w-[calc(50%-0.25rem)] sm:w-40" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los tipos</SelectItem>
            {SEO_TASK_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {SEO_TASK_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={assignedTo ?? ALL}
          onValueChange={(v) => setAssignedTo(v === ALL ? null : v)}
        >
          <SelectTrigger className="h-8 w-[calc(50%-0.25rem)] sm:w-44" aria-label="Responsable">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todo el equipo</SelectItem>
            <SelectItem value="me">Mis tareas</SelectItem>
            <SelectItem value="none">Sin asignar</SelectItem>
            {(assignees.data ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar"
          aria-label="Buscar tareas"
          className="h-8 w-full sm:w-44"
        />
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void csv()} disabled={downloading}>
            <Download className="mr-1 size-4" aria-hidden /> CSV
          </Button>
          {canEdit && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1 size-4" aria-hidden /> Nueva tarea
            </Button>
          )}
        </div>
      </div>

      {view === 'calendar' ? (
        <Calendar scope={scope} filters={filters} canEdit={canEdit} onOpen={setEditing} />
      ) : tasks.isError ? (
        <SectionError onRetry={() => void tasks.refetch()} />
      ) : tasks.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : view === 'board' ? (
        <Board
          tasks={items}
          today={today}
          canEdit={canEdit}
          onOpen={setEditing}
          onMove={(t, s, i) => void onMove(t, s, i)}
        />
      ) : (
        <TaskList tasks={items} today={today} onOpen={setEditing} />
      )}
      {tasks.data?.truncated && (
        <p className="text-xs text-muted-foreground">Hay más tareas de las que caben: filtra.</p>
      )}

      <TaskDialog
        scope={scope}
        domains={domains}
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        task={editing}
        canEdit={canEdit}
        onSaved={(t) => {
          if (editing && editing.status !== 'done' && t.status === 'done' && !t.changeId) {
            onRecordChange({
              title: t.title,
              urls: t.url ? [t.url] : [],
              keywords: t.keywords,
              domainId: t.domainId,
              taskId: t.id,
              opportunityId: t.opportunityId,
              cannibalizationId: t.cannibalizationId,
              indexFindingId: t.indexFindingId,
            });
          }
        }}
      />
    </div>
  );
}
