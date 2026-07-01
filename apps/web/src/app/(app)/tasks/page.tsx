'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ChecklistItemDto,
  type CreateTaskInput,
  CreateTaskSchema,
  type TaskDto,
  type TaskPriorityValue,
  type TaskStatusValue,
  type TaskTypeValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Check, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { DataTable } from '@/components/data-table';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useFacilities } from '@/lib/facilities/hooks';
import {
  useAddTaskComment,
  useCreateIncident,
  useCreateTask,
  useTask,
  useTaskComments,
  useTasks,
  useTransitionTask,
  useUpdateChecklistItem,
} from '@/lib/operations/hooks';
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
  in_progress: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

export default function TasksPage() {
  const [status, setStatus] = useState<TaskStatusValue | undefined>();
  const [type, setType] = useState<TaskTypeValue | undefined>();
  const [facilityId, setFacilityId] = useState<string | undefined>();
  const [assignedToUserId, setAssignedToUserId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const tasks = useTasks({
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(facilityId ? { facilityId } : {}),
    ...(assignedToUserId ? { assignedToUserId } : {}),
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

  const columns: ColumnDef<TaskDto>[] = [
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
      cell: ({ row }) =>
        row.original.dueDate ? new Date(row.original.dueDate).toLocaleDateString('es-ES') : '—',
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tareas</h1>
        <p className="text-sm text-muted-foreground">
          Limpieza, mantenimiento, inspecciones y otros encargos operativos del local.
        </p>
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
            {(users.data ?? []).map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={tasks.data ?? []}
        isLoading={tasks.isLoading}
        searchPlaceholder="Buscar por título..."
        emptyText="No hay tareas. Crea la primera para empezar."
        toolbarRight={
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
                                {(users.data ?? []).map((u) => (
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
                          <FormControl>
                            <Input
                              type="date"
                              {...field}
                              value={field.value ?? ''}
                              onChange={(e) => field.onChange(e.target.value || undefined)}
                            />
                          </FormControl>
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
        }
      />

      {detailId && <TaskDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function TaskDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const task = useTask(id);
  const comments = useTaskComments(id);
  const transition = useTransitionTask();
  const addComment = useAddTaskComment(id);
  const [body, setBody] = useState('');

  async function handleTransition(status: TaskStatusValue) {
    try {
      await transition.mutateAsync({ id, input: { status } });
      toast.success('Estado actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
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
          <DialogTitle>{task.data?.title ?? 'Cargando...'}</DialogTitle>
        </DialogHeader>
        {task.isLoading || !task.data ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
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
                <span>
                  {task.data.dueDate
                    ? new Date(task.data.dueDate).toLocaleDateString('es-ES')
                    : '—'}
                </span>
              </div>
            </div>
            {task.data.description && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                {task.data.description}
              </div>
            )}

            {NEXT_STATUS[task.data.status].length > 0 && (
              <div className="flex flex-wrap gap-2">
                {NEXT_STATUS[task.data.status].map((next) => (
                  <Button
                    key={next}
                    size="sm"
                    variant={next === 'cancelled' ? 'outline' : 'default'}
                    onClick={() => handleTransition(next)}
                    disabled={transition.isPending}
                  >
                    Marcar como {STATUS_LABELS[next].label.toLowerCase()}
                  </Button>
                ))}
              </div>
            )}

            {task.data.checklist.length > 0 && (
              <ChecklistSection
                taskId={task.data.id}
                facilityId={task.data.facilityId}
                checklist={task.data.checklist}
              />
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
    </Dialog>
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
  const updateItem = useUpdateChecklistItem(taskId);
  const createIncident = useCreateIncident();
  const doneCount = checklist.filter((it) => it.status !== 'pending').length;

  async function mark(item: ChecklistItemDto, status: 'ok' | 'issue') {
    let note: string | undefined;
    if (status === 'issue') {
      note = window.prompt('Describe la incidencia (opcional):') ?? undefined;
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
      toast.success('Incidencia creada.');
    } catch (err) {
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
              {item.status === 'issue' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={createIncident.isPending}
                  onClick={() => void openIncident(item)}
                >
                  Abrir incidencia
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
