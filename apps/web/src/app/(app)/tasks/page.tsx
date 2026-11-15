'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ChecklistItemDto,
  type CreateTaskInput,
  CreateTaskSchema,
  type TaskDto,
  type TaskDueFilter,
  type TaskPriorityValue,
  type TaskStatusValue,
  type TaskTypeValue,
} from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  Settings2,
  Trash2,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { DateSelect } from '@/components/month-year-select';
import { OpsExpenseDialog } from '@/components/operations/ops-expense-dialog';
import { OpsFiles } from '@/components/operations/ops-files';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
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
import { useHasPermission, useMe } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import {
  useBulkAssignTasks,
  useTaskAutoRules,
  useUpdateTaskAutoRules,
} from '@/lib/operations/features-hooks';
import {
  useAddTaskComment,
  useCreateIncident,
  useCreateTask,
  useDeleteTask,
  useTask,
  useTaskComments,
  useTransitionTask,
  useUpdateChecklistItem,
  useUpdateTask,
} from '@/lib/operations/hooks';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';
import { useOpenFromUrl } from '@/lib/use-open-from-url';
import { useUsers } from '@/lib/users/hooks';

const TYPE_LABELS: Record<TaskTypeValue, string> = {
  cleaning: 'Limpieza',
  maintenance: 'Mantenimiento',
  inspection: 'Inspección',
  other: 'Otro',
};

const STATUS_LABELS: Record<
  TaskStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  open: { label: 'Abierta', variant: 'secondary' },
  in_progress: { label: 'En curso', variant: 'default' },
  done: { label: 'Hecha', variant: 'outline' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

const PRIORITY_LABELS: Record<TaskPriorityValue, { label: string; className: string }> = {
  low: {
    label: 'Baja',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  normal: {
    label: 'Normal',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  high: {
    label: 'Alta',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  },
  urgent: {
    label: 'Urgente',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
};

const NEXT_STATUS: Record<TaskStatusValue, TaskStatusValue[]> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'open', 'cancelled'],
  done: ['open'],
  cancelled: ['open'],
};

const DUE_VIEWS: { value: TaskDueFilter | undefined; label: string }[] = [
  { value: undefined, label: 'Todas' },
  { value: 'overdue', label: 'Atrasadas' },
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Esta semana' },
  { value: 'none', label: 'Sin fecha' },
];

function transitionLabel(from: TaskStatusValue, to: TaskStatusValue): string {
  if (to === 'open') return from === 'in_progress' ? 'Volver a abierta' : 'Reabrir';
  return `Marcar como ${STATUS_LABELS[to].label.toLowerCase()}`;
}

export default function TasksPage() {
  const [status, setStatus] = useState<TaskStatusValue | undefined>();
  // Vista de pendientes: atrasadas, de hoy, de la semana o sin fecha.
  const [due, setDue] = useState<TaskDueFilter | undefined>();
  const [type, setType] = useState<TaskTypeValue | undefined>();
  const [facilityId, setFacilityId] = useFacilityFilterState();
  const [assignedToUserId, setAssignedToUserId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  useOpenFromUrl(() => setCreateOpen(true));
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [assignTo, setAssignTo] = useState<string>('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const me = useMe();
  const myId = me.data?.user.id;
  const canWrite = useHasPermission('tasks:write');
  const canManage = useHasPermission('tasks:manage');
  const bulkAssign = useBulkAssignTasks();

  // `?mine=1` (desde el aviso de asignación) filtra mis tareas; `?task=` abre una.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const task = qs.get('task');
    if (task) setDetailId(task);
    if (qs.get('mine') === '1' && myId) setAssignedToUserId(myId);
  }, [myId]);

  const [searchText, search, setSearchText] = useDebouncedSearch();
  const tasks = usePagedList<TaskDto>('tasks', '/tasks', {
    due,
    status,
    type,
    facilityId,
    assignedToUserId,
    search: search || undefined,
  });
  const facilities = useFacilities();
  const users = useUsers();
  const create = useCreateTask();

  const form = useForm<CreateTaskInput>({
    resolver: zodResolver(CreateTaskSchema),
    defaultValues: {
      type: 'other',
      priority: 'normal',
      title: '',
      description: '',
      metadata: {},
    },
  });

  async function onSubmit(values: CreateTaskInput) {
    try {
      // Limpia campos vacios (no enviarlos como '' para evitar fallar uuid)
      const payload: CreateTaskInput = {
        type: values.type,
        priority: values.priority,
        title: values.title,
        metadata: values.metadata,
        ...(values.description ? { description: values.description } : {}),
        ...(values.facilityId ? { facilityId: values.facilityId } : {}),
        ...(values.unitId ? { unitId: values.unitId } : {}),
        ...(values.assignedToUserId ? { assignedToUserId: values.assignedToUserId } : {}),
        ...(values.dueDate ? { dueDate: values.dueDate } : {}),
      };
      await create.mutateAsync(payload);
      toast.success('Tarea creada.');
      form.reset();
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function assignSelected() {
    try {
      const res = await bulkAssign.mutateAsync({
        taskIds: selected,
        assignedToUserId: assignTo === 'none' ? null : assignTo,
      });
      toast.success(
        `${res.updated} tarea${res.updated === 1 ? '' : 's'} asignada${res.updated === 1 ? '' : 's'}.`,
      );
      setSelected([]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo asignar');
    }
  }

  const rows = tasks.rows;
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));
  const columns: ColumnDef<TaskDto>[] = [
    ...(canWrite
      ? [
          {
            id: 'select',
            meta: { mobileHidden: true },
            header: () => (
              <input
                type="checkbox"
                aria-label="Seleccionar todas"
                checked={allSelected}
                onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
              />
            ),
            cell: ({ row }: { row: { original: TaskDto } }) => (
              <input
                type="checkbox"
                aria-label={`Seleccionar ${row.original.title}`}
                checked={selected.includes(row.original.id)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked
                      ? [...prev, row.original.id]
                      : prev.filter((x) => x !== row.original.id),
                  )
                }
              />
            ),
          } as ColumnDef<TaskDto>,
        ]
      : []),
    {
      accessorKey: 'priority',
      header: 'Prioridad',
      cell: ({ row }) => {
        const p = PRIORITY_LABELS[row.original.priority];
        return (
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${p.className}`}>
            {p.label}
          </span>
        );
      },
    },
    {
      accessorKey: 'type',
      header: 'Tipo',
      cell: ({ row }) => <Badge variant="outline">{TYPE_LABELS[row.original.type]}</Badge>,
    },
    {
      accessorKey: 'title',
      header: 'Título',
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => setDetailId(row.original.id)}
          className="text-left font-medium hover:underline"
        >
          {row.original.title}
        </button>
      ),
    },
    {
      accessorKey: 'assignedToName',
      header: 'Asignada a',
      cell: ({ row }) => row.original.assignedToName ?? '—',
    },
    {
      accessorKey: 'facilityName',
      header: 'Local',
      cell: ({ row }) => row.original.facilityName ?? '—',
    },
    {
      accessorKey: 'dueDate',
      header: 'Vence',
      cell: ({ row }) => (row.original.dueDate ? formatDate(row.original.dueDate) : '—'),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS_LABELS[row.original.status];
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
  ];

  if (tasks.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tareas</h1>
          <p className="text-sm text-muted-foreground">
            Limpieza, mantenimiento, inspecciones y otros encargos operativos del local.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button variant="outline" onClick={() => setRulesOpen(true)}>
              <Settings2 className="mr-1 h-4 w-4" /> Tareas automáticas
            </Button>
          )}
          <Can permission="tasks:write">
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-1 h-4 w-4" /> Nueva tarea
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Nueva tarea</DialogTitle>
                </DialogHeader>
                <Form {...form}>
                  <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                    <FormField
                      control={form.control}
                      name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Título</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value ?? ''} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="type"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tipo</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value ?? 'other'}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {(Object.keys(TYPE_LABELS) as TaskTypeValue[]).map((t) => (
                                  <SelectItem key={t} value={t}>
                                    {TYPE_LABELS[t]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="priority"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Prioridad</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value ?? 'normal'}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {(Object.keys(PRIORITY_LABELS) as TaskPriorityValue[]).map((p) => (
                                  <SelectItem key={p} value={p}>
                                    {PRIORITY_LABELS[p].label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="facilityId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Local</FormLabel>
                            <Select
                              onValueChange={(v) => field.onChange(v === 'none' ? undefined : v)}
                              value={field.value ?? 'none'}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="(sin local)" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="none">(sin local)</SelectItem>
                                {(facilities.data ?? []).map((f) => (
                                  <SelectItem key={f.id} value={f.id}>
                                    {f.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="assignedToUserId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Asignar a</FormLabel>
                            <Select
                              onValueChange={(v) => field.onChange(v === 'none' ? undefined : v)}
                              value={field.value ?? 'none'}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="(sin asignar)" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="none">(sin asignar)</SelectItem>
                                {(users.data ?? [])
                                  .filter((u) => u.isActive)
                                  .map((u) => (
                                    <SelectItem key={u.id} value={u.id}>
                                      {u.fullName}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="dueDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Fecha límite</FormLabel>
                          <div className="flex flex-wrap items-center gap-2">
                            <DateSelect
                              around
                              value={field.value ?? undefined}
                              onChange={(v) => field.onChange(v)}
                            />
                            {field.value && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => field.onChange(undefined)}
                              >
                                Quitar
                              </Button>
                            )}
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Descripción</FormLabel>
                          <FormControl>
                            <Textarea {...field} value={field.value ?? ''} rows={3} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                        Cancelar
                      </Button>
                      <Button type="submit" disabled={form.formState.isSubmitting}>
                        {form.formState.isSubmitting ? 'Creando...' : 'Crear'}
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </Can>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 rounded-md border p-0.5 sm:w-fit">
        {DUE_VIEWS.map((v) => (
          <Button
            key={v.value ?? 'all'}
            size="sm"
            variant={due === v.value ? 'default' : 'ghost'}
            className="h-8"
            onClick={() => setDue(v.value)}
          >
            {v.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as TaskStatusValue))}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as TaskStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={type ?? 'all'}
          onValueChange={(v) => setType(v === 'all' ? undefined : (v as TaskTypeValue))}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tipos</SelectItem>
            {(Object.keys(TYPE_LABELS) as TaskTypeValue[]).map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={facilityId ?? 'all'}
          onValueChange={(v) => setFacilityId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los locales</SelectItem>
            {(facilities.data ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={assignedToUserId ?? 'all'}
          onValueChange={(v) => setAssignedToUserId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Asignada a" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Cualquiera</SelectItem>
            {myId && <SelectItem value={myId}>Mis tareas</SelectItem>}
            {(users.data ?? []).map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">
            {selected.length} seleccionada{selected.length === 1 ? '' : 's'}
          </span>
          <Select value={assignTo} onValueChange={setAssignTo}>
            <SelectTrigger className="h-9 w-[200px]">
              <SelectValue placeholder="Asignar a…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sin asignar</SelectItem>
              {(users.data ?? [])
                .filter((u) => u.isActive)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={assignSelected} disabled={!assignTo || bulkAssign.isPending}>
            <UserCheck className="mr-1 h-4 w-4" /> Asignar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Quitar selección
          </Button>
        </div>
      )}

      {tasks.isError && <SectionError onRetry={() => void tasks.refetch()} />}

      <DataTable
        filtersActive={!!status || !!type || !!assignedToUserId || !!due}
        onClearFilters={() => {
          setDue(undefined);
          setStatus(undefined);
          setType(undefined);
          setAssignedToUserId(undefined);
        }}
        onRowClick={(t) => setDetailId(t.id)}
        columns={columns}
        data={rows}
        isLoading={tasks.isLoading}
        guide="tareas"
        emptyText="No hay tareas. Crea la primera con «Nueva tarea»."
        serverSearch={{
          value: searchText,
          onChange: setSearchText,
          placeholder: 'Buscar por título…',
        }}
        loadMore={tasks.loadMore}
      />

      {detailId && <TaskDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
      {rulesOpen && <AutoRulesDialog onClose={() => setRulesOpen(false)} />}
    </div>
  );
}

/** Tareas que se crean solas con los contratos. */
function AutoRulesDialog({ onClose }: { onClose: () => void }) {
  const rules = useTaskAutoRules();
  const save = useUpdateTaskAutoRules();
  const [draft, setDraft] = useState(rules.data ?? null);
  useEffect(() => {
    if (rules.data && !draft) setDraft(rules.data);
  }, [rules.data, draft]);

  async function submit() {
    if (!draft) return;
    try {
      await save.mutateAsync(draft);
      toast.success('Tareas automáticas guardadas.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tareas automáticas</DialogTitle>
        </DialogHeader>
        {!draft ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.welcomeCall.enabled}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    welcomeCall: { ...draft.welcomeCall, enabled: e.target.checked },
                  })
                }
              />
              <span className="flex-1">
                Llamada de bienvenida
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  a los
                  <Input
                    type="number"
                    min={0}
                    max={60}
                    className="h-8 w-16"
                    value={draft.welcomeCall.days}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        welcomeCall: { ...draft.welcomeCall, days: Number(e.target.value) || 0 },
                      })
                    }
                  />
                  días de firmar
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.moveOutInspection.enabled}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    moveOutInspection: { ...draft.moveOutInspection, enabled: e.target.checked },
                  })
                }
              />
              <span className="flex-1">
                Revisar el trastero tras la salida
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  a los
                  <Input
                    type="number"
                    min={0}
                    max={30}
                    className="h-8 w-16"
                    value={draft.moveOutInspection.days}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        moveOutInspection: {
                          ...draft.moveOutInspection,
                          days: Number(e.target.value) || 0,
                        },
                      })
                    }
                  />
                  días del cierre
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.renewalCall.enabled}
                onChange={(e) => setDraft({ ...draft, renewalCall: { enabled: e.target.checked } })}
              />
              <span>
                Llamar para renovar
                <span className="block text-xs text-muted-foreground">
                  Cuando un contrato sin renovación automática está a 30 días de vencer.
                </span>
              </span>
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!draft || save.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const ask = useConfirm();
  const task = useTask(id);
  const comments = useTaskComments(id);
  const transition = useTransitionTask();
  const remove = useDeleteTask();
  const addComment = useAddTaskComment(id);
  const canWrite = useHasPermission('tasks:write');
  const canManage = useHasPermission('tasks:manage');
  const canExpense = useHasPermission('expenses:manage');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const notFound = task.error instanceof ApiError && task.error.statusCode === 404;

  async function handleTransition(status: TaskStatusValue) {
    let reason: string | undefined;
    if (status === 'cancelled') {
      const res = await ask({
        title: '¿Cancelar la tarea?',
        input: { label: 'Motivo (opcional)' },
        confirmLabel: 'Cancelar la tarea',
        destructive: true,
      });
      if (!res) return;
      reason = res.value || undefined;
    }
    try {
      await transition.mutateAsync({ id, input: { status, ...(reason ? { reason } : {}) } });
      toast.success('Estado actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete() {
    if (
      !(await ask({
        title: '¿Borrar la tarea?',
        description: 'Desaparece de la lista y del calendario.',
        confirmLabel: 'Borrar',
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync(id);
      toast.success('Tarea borrada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar.');
    }
  }

  async function handleAddComment() {
    if (!body.trim()) return;
    try {
      await addComment.mutateAsync({ body });
      setBody('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{task.data?.title ?? (task.isError ? 'Tarea' : 'Cargando...')}</DialogTitle>
        </DialogHeader>
        {task.isError ? (
          notFound ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Esta tarea ya no existe o no es de tus locales.
            </p>
          ) : (
            <SectionError onRetry={() => void task.refetch()} />
          )
        ) : task.isLoading || !task.data ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : editing ? (
          <TaskEditForm task={task.data} onDone={() => setEditing(false)} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-muted-foreground">Estado</div>
                <Badge variant={STATUS_LABELS[task.data.status].variant}>
                  {STATUS_LABELS[task.data.status].label}
                </Badge>
              </div>
              <div>
                <div className="text-muted-foreground">Prioridad</div>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                    PRIORITY_LABELS[task.data.priority].className
                  }`}
                >
                  {PRIORITY_LABELS[task.data.priority].label}
                </span>
              </div>
              <div>
                <div className="text-muted-foreground">Tipo</div>
                <span>{TYPE_LABELS[task.data.type]}</span>
              </div>
              <div>
                <div className="text-muted-foreground">Asignada a</div>
                <span>{task.data.assignedToName ?? '—'}</span>
              </div>
              <div>
                <div className="text-muted-foreground">Local</div>
                <span>{task.data.facilityName ?? '—'}</span>
              </div>
              <div>
                <div className="text-muted-foreground">Vence</div>
                <span>{task.data.dueDate ? formatDate(task.data.dueDate) : '—'}</span>
              </div>
            </div>
            {task.data.description && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                {task.data.description}
              </div>
            )}

            {canWrite && (
              <div className="flex flex-wrap gap-2">
                {NEXT_STATUS[task.data.status].map((next) => (
                  <Button
                    key={next}
                    size="sm"
                    variant={next === 'cancelled' || next === 'open' ? 'outline' : 'default'}
                    onClick={() => void handleTransition(next)}
                    disabled={transition.isPending}
                  >
                    {transitionLabel(task.data!.status, next)}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil className="mr-1 h-4 w-4" /> Editar
                </Button>
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => void handleDelete()}
                    disabled={remove.isPending}
                  >
                    <Trash2 className="mr-1 h-4 w-4" /> Borrar
                  </Button>
                )}
              </div>
            )}

            {task.data.checklist.length > 0 && (
              <ChecklistSection
                taskId={task.data.id}
                facilityId={task.data.facilityId}
                checklist={task.data.checklist}
              />
            )}

            <OpsFiles
              files={task.data.photos}
              basePath={`/tasks/${task.data.id}/photos`}
              canEdit={canWrite}
              onChanged={() => void task.refetch()}
            />

            {task.data.expenseId && task.data.expenseId !== 'pending' ? (
              <p className="text-sm text-muted-foreground">
                Gasto apuntado ·{' '}
                <Link href="/expenses" className="text-primary hover:underline">
                  Ver en Gastos
                </Link>
              </p>
            ) : (
              canExpense && (
                <Button size="sm" variant="outline" onClick={() => setExpenseOpen(true)}>
                  <Receipt className="mr-1 h-4 w-4" /> Apuntar el gasto
                  {task.data.estimatedCost ? ` (${formatEur(task.data.estimatedCost)})` : ''}
                </Button>
              )
            )}

            <div className="space-y-2">
              <h3 className="text-sm font-medium">Comentarios</h3>
              <div className="max-h-48 space-y-2 overflow-y-auto">
                {(comments.data ?? []).map((c) => (
                  <div key={c.id} className="rounded-md border p-2 text-sm">
                    <div className="text-xs text-muted-foreground">
                      {c.authorName ?? 'Sistema'} · {new Date(c.createdAt).toLocaleString('es-ES')}
                    </div>
                    <div className="whitespace-pre-wrap">{c.body}</div>
                  </div>
                ))}
                {(comments.data ?? []).length === 0 && (
                  <p className="text-xs text-muted-foreground">— Sin comentarios —</p>
                )}
              </div>
              <div className="flex gap-2">
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={2}
                  placeholder="Añadir comentario..."
                />
                <Button
                  size="sm"
                  onClick={handleAddComment}
                  disabled={!body.trim() || addComment.isPending}
                >
                  Enviar
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
      {expenseOpen && task.data && (
        <OpsExpenseDialog
          path={`/tasks/${task.data.id}/expense`}
          title={task.data.title}
          defaultAmount={task.data.estimatedCost}
          defaultSupplierId={task.data.supplierId}
          onClose={() => setExpenseOpen(false)}
          onDone={() => {
            setExpenseOpen(false);
            void task.refetch();
          }}
        />
      )}
    </Dialog>
  );
}

function TaskEditForm({ task, onDone }: { task: TaskDto; onDone: () => void }) {
  const update = useUpdateTask(task.id);
  const facilities = useFacilities();
  const users = useUsers();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [type, setType] = useState<TaskTypeValue>(task.type);
  const [priority, setPriority] = useState<TaskPriorityValue>(task.priority);
  const [facilityId, setFacilityId] = useState<string>(task.facilityId ?? 'none');
  const [assignee, setAssignee] = useState<string>(task.assignedToUserId ?? 'none');
  const [dueDate, setDueDate] = useState(task.dueDate?.slice(0, 10) ?? '');

  async function save() {
    if (!title.trim()) {
      toast.error('El título no puede quedar vacío.');
      return;
    }
    try {
      await update.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        type,
        priority,
        facilityId: facilityId === 'none' ? null : facilityId,
        // Cambiar de local quita el trastero si era de otro (el servidor lo comprueba).
        ...(facilityId !== (task.facilityId ?? 'none') ? { unitId: null } : {}),
        assignedToUserId: assignee === 'none' ? null : assignee,
        dueDate: dueDate || null,
      });
      toast.success('Tarea guardada.');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="task-edit-title">Título</Label>
        <Input id="task-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Tipo</Label>
          <Select value={type} onValueChange={(v) => setType(v as TaskTypeValue)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Prioridad</Label>
          <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriorityValue)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Local</Label>
          <Select value={facilityId} onValueChange={setFacilityId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">(sin local)</SelectItem>
              {(facilities.data ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Asignada a</Label>
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">(sin asignar)</SelectItem>
              {(users.data ?? [])
                .filter((u) => u.isActive || u.id === task.assignedToUserId)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label>Fecha límite</Label>
        <div className="flex flex-wrap items-center gap-2">
          <DateSelect around value={dueDate || undefined} onChange={(v) => setDueDate(v ?? '')} />
          {dueDate && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDueDate('')}>
              Quitar
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="task-edit-desc">Descripción</Label>
        <Textarea
          id="task-edit-desc"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Cancelar
        </Button>
        <Button onClick={() => void save()} disabled={update.isPending}>
          Guardar
        </Button>
      </div>
    </div>
  );
}

function ChecklistSection({
  taskId,
  facilityId,
  checklist,
}: {
  taskId: string;
  facilityId: string | null;
  checklist: ChecklistItemDto[];
}) {
  const ask = useConfirm();
  const updateItem = useUpdateChecklistItem(taskId);
  const createIncident = useCreateIncident();
  const qc = useQueryClient();
  const doneCount = checklist.filter((it) => it.status !== 'pending').length;

  async function mark(item: ChecklistItemDto, status: 'ok' | 'issue') {
    let note: string | undefined;
    if (status === 'issue') {
      const res = await ask({
        title: 'Marcar como incidencia',
        input: { label: 'Describe la incidencia (opcional)' },
      });
      if (!res) return;
      note = res.value || undefined;
    }
    try {
      await updateItem.mutateAsync({ itemId: item.id, status, ...(note ? { note } : {}) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function openIncident(item: ChecklistItemDto) {
    try {
      await createIncident.mutateAsync({
        title: `Ronda: ${item.label}`,
        description: item.note ?? '',
        severity: 'medium',
        ...(facilityId ? { facilityId } : {}),
        metadata: { source: 'checklist', taskId, checklistItemId: item.id },
      });
      // El punto queda enlazado a la incidencia: se vuelve a leer la tarea.
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      toast.success('Incidencia creada.');
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'incident_already_open') {
        toast.info('Este punto ya tiene una incidencia abierta.');
        void qc.invalidateQueries({ queryKey: ['tasks'] });
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear la incidencia.');
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        Checklist{' '}
        <span className="text-xs font-normal text-muted-foreground">
          ({doneCount}/{checklist.length})
        </span>
      </h3>
      <ul className="space-y-1.5">
        {checklist.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <span
                className={
                  item.status === 'ok'
                    ? 'text-muted-foreground line-through'
                    : item.status === 'issue'
                      ? 'font-medium text-red-600'
                      : ''
                }
              >
                {item.label}
              </span>
              {item.note && (
                <span className="block text-xs text-muted-foreground">{item.note}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={item.status === 'ok' ? 'default' : 'outline'}
                className="h-7 px-2"
                disabled={updateItem.isPending}
                onClick={() => void mark(item, 'ok')}
                aria-label="Marcar OK"
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant={item.status === 'issue' ? 'destructive' : 'outline'}
                className="h-7 px-2"
                disabled={updateItem.isPending}
                onClick={() => void mark(item, 'issue')}
                aria-label="Marcar incidencia"
              >
                <AlertTriangle className="h-4 w-4" />
              </Button>
              {item.status === 'issue' &&
                (item.incidentId ? (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
                    <Link href={`/incidents?incident=${item.incidentId}`}>Ver incidencia</Link>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={createIncident.isPending}
                    onClick={() => void openIncident(item)}
                  >
                    Abrir incidencia
                  </Button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
