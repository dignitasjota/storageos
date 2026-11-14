'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateIncidentInput,
  CreateIncidentSchema,
  type IncidentDto,
  type IncidentSeverityValue,
  type IncidentStatusValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Eye, Loader2, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useCameraEventsByIncident } from '@/lib/cameras/hooks';
import { useFacilities, useUnits } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatDateTime } from '@/lib/format';
import { useIncidentContext } from '@/lib/operations/features-hooks';
import {
  useAddIncidentComment,
  useCreateIncident,
  useIncident,
  useIncidentComments,
  useTransitionIncident,
  useUpdateIncident,
} from '@/lib/operations/hooks';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';
import { useUsers } from '@/lib/users/hooks';

const SEVERITY_LABELS: Record<IncidentSeverityValue, { label: string; className: string }> = {
  low: {
    label: 'Baja',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  medium: {
    label: 'Media',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  high: {
    label: 'Alta',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  },
  critical: {
    label: 'Crítica',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
};

const STATUS_LABELS: Record<
  IncidentStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  reported: { label: 'Reportada', variant: 'secondary' },
  investigating: { label: 'En investigación', variant: 'default' },
  resolved: { label: 'Resuelta', variant: 'outline' },
  dismissed: { label: 'Descartada', variant: 'outline' },
};

const NEXT_STATUS: Record<IncidentStatusValue, IncidentStatusValue[]> = {
  reported: ['investigating', 'resolved', 'dismissed'],
  investigating: ['resolved', 'dismissed'],
  resolved: ['reported'],
  dismissed: ['reported'],
};

export default function IncidentsPage() {
  const [status, setStatus] = useState<IncidentStatusValue | undefined>();
  const [severity, setSeverity] = useState<IncidentSeverityValue | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // `?incident=<id>` (desde un aviso) abre la ficha.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('incident');
    if (id) setDetailId(id);
  }, []);

  const headerFacilityId = useHeaderFacilityId();
  const [searchText, search, setSearchText] = useDebouncedSearch();
  const incidents = usePagedList<IncidentDto>('incidents', '/incidents', {
    facilityId: headerFacilityId,
    status,
    severity,
    search: search || undefined,
  });
  const facilities = useFacilities();
  const create = useCreateIncident();

  const form = useForm<CreateIncidentInput>({
    resolver: zodResolver(CreateIncidentSchema),
    defaultValues: {
      severity: 'medium',
      title: '',
      description: '',
      visibleToCustomer: false,
      metadata: {},
    },
  });

  async function onSubmit(values: CreateIncidentInput) {
    try {
      const payload: CreateIncidentInput = {
        severity: values.severity,
        title: values.title,
        metadata: values.metadata,
        ...(values.description ? { description: values.description } : {}),
        ...(values.facilityId ? { facilityId: values.facilityId } : {}),
        ...(values.unitId ? { unitId: values.unitId } : {}),
        ...(values.customerId ? { customerId: values.customerId } : {}),
        ...(values.contractId ? { contractId: values.contractId } : {}),
        ...(values.occurredAt ? { occurredAt: values.occurredAt } : {}),
        ...(values.assignedToUserId ? { assignedToUserId: values.assignedToUserId } : {}),
        ...(values.customerId && values.visibleToCustomer ? { visibleToCustomer: true } : {}),
      };
      await create.mutateAsync(payload);
      toast.success('Incidencia creada.');
      form.reset();
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<IncidentDto>[] = [
    {
      accessorKey: 'severity',
      header: 'Severidad',
      cell: ({ row }) => {
        const s = SEVERITY_LABELS[row.original.severity];
        return (
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${s.className}`}>
            {s.label}
          </span>
        );
      },
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
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) =>
        row.original.customerId ? (
          <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
            {row.original.customerName}
          </Link>
        ) : (
          (row.original.customerName ?? '—')
        ),
    },
    {
      accessorKey: 'facilityName',
      header: 'Local',
      cell: ({ row }) =>
        row.original.facilityId ? (
          <Link href={`/facilities/${row.original.facilityId}`} className="hover:underline">
            {row.original.facilityName}
          </Link>
        ) : (
          (row.original.facilityName ?? '—')
        ),
    },
    {
      accessorKey: 'createdAt',
      header: 'Reportada',
      cell: ({ row }) => formatDate(row.original.createdAt),
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

  if (incidents.isLoading) {
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
          <h1 className="text-2xl font-semibold tracking-tight">Incidencias</h1>
          <p className="text-sm text-muted-foreground">
            Robos, daños, quejas o cualquier evento que requiera atención.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Can permission="incidents:write">
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-1 h-4 w-4" /> Reportar incidencia
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Reportar incidencia</DialogTitle>
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
                    <FormField
                      control={form.control}
                      name="severity"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Severidad</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value ?? 'medium'}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {(Object.keys(SEVERITY_LABELS) as IncidentSeverityValue[]).map(
                                (s) => (
                                  <SelectItem key={s} value={s}>
                                    {SEVERITY_LABELS[s].label}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
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
                        name="customerId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Inquilino</FormLabel>
                            <CustomerSearchSelect
                              value={field.value ?? undefined}
                              onChange={(id) => field.onChange(id)}
                              clearLabel="(sin inquilino)"
                            />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="unitId"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Trastero</FormLabel>
                            <IncidentUnitSelect
                              facilityId={form.watch('facilityId')}
                              value={field.value ?? undefined}
                              onChange={(v) => field.onChange(v)}
                            />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="occurredAt"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Cuándo pasó</FormLabel>
                            <DateSelect
                              value={field.value ? field.value.slice(0, 10) : undefined}
                              onChange={(d) =>
                                field.onChange(
                                  d ? new Date(`${d}T12:00:00.000Z`).toISOString() : undefined,
                                )
                              }
                            />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Descripción</FormLabel>
                          <FormControl>
                            <Textarea {...field} value={field.value ?? ''} rows={4} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {form.watch('customerId') && (
                      <FormField
                        control={form.control}
                        name="visibleToCustomer"
                        render={({ field }) => (
                          <label className="flex items-start gap-2 text-sm">
                            <Checkbox
                              checked={field.value === true}
                              onCheckedChange={(v) => field.onChange(v === true)}
                            />
                            <span>
                              Visible para el inquilino
                              <span className="block text-xs text-muted-foreground">
                                La verá en su área de clientes con el estado y la resolución.
                              </span>
                            </span>
                          </label>
                        )}
                      />
                    )}
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

      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : (v as IncidentStatusValue))}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as IncidentStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={severity ?? 'all'}
          onValueChange={(v) => setSeverity(v === 'all' ? undefined : (v as IncidentSeverityValue))}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Severidad" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Cualquiera</SelectItem>
            {(Object.keys(SEVERITY_LABELS) as IncidentSeverityValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SEVERITY_LABELS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {incidents.isError && <SectionError onRetry={() => void incidents.refetch()} />}

      <DataTable
        filtersActive={!!status || !!severity}
        onClearFilters={() => {
          setStatus(undefined);
          setSeverity(undefined);
        }}
        onRowClick={(i) => setDetailId(i.id)}
        columns={columns}
        data={incidents.rows}
        isLoading={incidents.isLoading}
        guide="tareas"
        emptyText="No hay incidencias. Cuando un inquilino o tu equipo reporten una, aparecerá aquí."
        serverSearch={{
          value: searchText,
          onChange: setSearchText,
          placeholder: 'Buscar por título…',
        }}
        loadMore={incidents.loadMore}
      />

      {detailId && <IncidentDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function IncidentDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const ask = useConfirm();
  const incident = useIncident(id);
  const comments = useIncidentComments(id);
  const transition = useTransitionIncident();
  const addComment = useAddIncidentComment(id);
  const canWrite = useHasPermission('incidents:write');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState(false);
  const notFound = incident.error instanceof ApiError && incident.error.statusCode === 404;

  async function handleTransition(next: IncidentStatusValue) {
    let resolution: string | undefined;
    if (next === 'resolved' || next === 'dismissed') {
      const shown = incident.data?.visibleToCustomer;
      const res = await ask({
        title: next === 'resolved' ? 'Marcar como resuelta' : 'Descartar la incidencia',
        description: shown
          ? 'El inquilino la ve en su área de clientes: escribe qué se ha hecho.'
          : 'Queda en la ficha para saber cómo se cerró.',
        input: {
          label: next === 'resolved' ? '¿Qué se ha hecho?' : '¿Por qué se descarta?',
        },
        confirmLabel: next === 'resolved' ? 'Resolver' : 'Descartar',
      });
      if (!res) return;
      resolution = res.value.trim() || undefined;
    }
    try {
      await transition.mutateAsync({
        id,
        input: { status: next, ...(resolution ? { resolution } : {}) },
      });
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
          <DialogTitle>
            {incident.data?.title ?? (incident.isError ? 'Incidencia' : 'Cargando...')}
          </DialogTitle>
        </DialogHeader>
        {incident.isError ? (
          notFound ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Esta incidencia ya no existe o no es de tus locales.
            </p>
          ) : (
            <SectionError onRetry={() => void incident.refetch()} />
          )
        ) : incident.isLoading || !incident.data ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : editing ? (
          <IncidentEditForm incident={incident.data} onDone={() => setEditing(false)} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-muted-foreground">Estado</div>
                <Badge variant={STATUS_LABELS[incident.data.status].variant}>
                  {STATUS_LABELS[incident.data.status].label}
                </Badge>
              </div>
              <div>
                <div className="text-muted-foreground">Severidad</div>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                    SEVERITY_LABELS[incident.data.severity].className
                  }`}
                >
                  {SEVERITY_LABELS[incident.data.severity].label}
                </span>
              </div>
              <div>
                <div className="text-muted-foreground">Local</div>
                <span>{incident.data.facilityName ?? '—'}</span>
              </div>
              <div>
                <div className="text-muted-foreground">Inquilino</div>
                <span>{incident.data.customerName ?? '—'}</span>
                {incident.data.visibleToCustomer && (
                  <Badge variant="outline" className="ml-2">
                    <Eye className="mr-1 h-3 w-3" /> La ve el inquilino
                  </Badge>
                )}
              </div>
              <div>
                <div className="text-muted-foreground">Trastero</div>
                <span>{incident.data.unitCode ?? '—'}</span>
              </div>
              <div>
                <div className="text-muted-foreground">Responsable</div>
                <span>{incident.data.assignedToName ?? '—'}</span>
              </div>
            </div>
            {incident.data.description && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                {incident.data.description}
              </div>
            )}
            {incident.data.resolution &&
              (incident.data.status === 'resolved' || incident.data.status === 'dismissed') && (
                <div className="rounded-md border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">
                    {incident.data.status === 'resolved' ? 'Resolución' : 'Motivo'}
                  </div>
                  <div className="whitespace-pre-wrap">{incident.data.resolution}</div>
                </div>
              )}

            {canWrite && (
              <div className="flex flex-wrap gap-2">
                {NEXT_STATUS[incident.data.status].map((next) => (
                  <Button
                    key={next}
                    size="sm"
                    variant={next === 'dismissed' ? 'outline' : 'default'}
                    onClick={() => handleTransition(next)}
                    disabled={transition.isPending}
                  >
                    {next === 'reported'
                      ? 'Reabrir'
                      : `Marcar como ${STATUS_LABELS[next].label.toLowerCase()}`}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil className="mr-1 h-4 w-4" /> Editar
                </Button>
              </div>
            )}

            <IncidentContextSection incidentId={id} />
            <CameraEventsSection incidentId={id} />

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

/**
 * Eventos de cámara/alarma vinculados a la incidencia (cross-link). Se auto-oculta
 * si el tenant no tiene la feature de cámaras, si el usuario no puede verlas, o si
 * no hay eventos vinculados.
 */
function CameraEventsSection({ incidentId }: { incidentId: string }) {
  const canAccessRead = useHasPermission('access:read');
  const hasCamerasFeature = useHasFeature('cameras');
  const canSee = canAccessRead && hasCamerasFeature;
  const events = useCameraEventsByIncident(canSee ? incidentId : null);
  if (!canSee || (events.data ?? []).length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Eventos de cámara</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {(events.data ?? []).map((e) => (
          <div key={e.id} className="overflow-hidden rounded-md border">
            {e.snapshotUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={e.snapshotUrl}
                alt={e.eventType}
                className="h-20 w-full bg-muted object-cover"
              />
            ) : (
              <div className="flex h-20 w-full items-center justify-center bg-muted text-muted-foreground">
                <span className="text-xs">sin imagen</span>
              </div>
            )}
            <div className="p-1.5">
              <p className="truncate text-xs font-medium">{e.eventType}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {e.cameraName} · {new Date(e.occurredAt).toLocaleString('es-ES')}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IncidentEditForm({ incident, onDone }: { incident: IncidentDto; onDone: () => void }) {
  const update = useUpdateIncident(incident.id);
  const facilities = useFacilities();
  const users = useUsers();
  const [title, setTitle] = useState(incident.title);
  const [description, setDescription] = useState(incident.description ?? '');
  const [severity, setSeverity] = useState<IncidentSeverityValue>(incident.severity);
  const [facilityId, setFacilityId] = useState<string | undefined>(
    incident.facilityId ?? undefined,
  );
  const [unitId, setUnitId] = useState<string | undefined>(incident.unitId ?? undefined);
  const [assignee, setAssignee] = useState<string>(incident.assignedToUserId ?? 'none');
  const [visible, setVisible] = useState(incident.visibleToCustomer);

  async function save() {
    if (!title.trim()) {
      toast.error('El título no puede quedar vacío.');
      return;
    }
    try {
      await update.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        severity,
        facilityId: facilityId ?? null,
        unitId: unitId ?? null,
        assignedToUserId: assignee === 'none' ? null : assignee,
        ...(incident.customerId ? { visibleToCustomer: visible } : {}),
      });
      toast.success('Incidencia guardada.');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="inc-edit-title">Título</Label>
        <Input id="inc-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Severidad</Label>
          <Select value={severity} onValueChange={(v) => setSeverity(v as IncidentSeverityValue)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SEVERITY_LABELS) as IncidentSeverityValue[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {SEVERITY_LABELS[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Responsable</Label>
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">(sin asignar)</SelectItem>
              {(users.data ?? [])
                .filter((u) => u.isActive || u.id === incident.assignedToUserId)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Local</Label>
          <Select
            value={facilityId ?? 'none'}
            onValueChange={(v) => {
              setFacilityId(v === 'none' ? undefined : v);
              setUnitId(undefined);
            }}
          >
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
          <Label>Trastero</Label>
          <IncidentUnitSelect facilityId={facilityId} value={unitId} onChange={setUnitId} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="inc-edit-desc">Descripción</Label>
        <Textarea
          id="inc-edit-desc"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {incident.customerId && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={visible} onCheckedChange={(v) => setVisible(v === true)} />
          <span>
            Visible para el inquilino
            <span className="block text-xs text-muted-foreground">
              La verá en su área de clientes con el estado y la resolución.
            </span>
          </span>
        </label>
      )}
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

/** Trasteros del local elegido (sin local, no se puede elegir trastero). */
function IncidentUnitSelect({
  facilityId,
  value,
  onChange,
}: {
  facilityId: string | undefined;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const units = useUnits(facilityId ? { facilityId } : {});
  return (
    <Select
      value={value ?? 'none'}
      onValueChange={(v) => onChange(v === 'none' ? undefined : v)}
      disabled={!facilityId}
    >
      <SelectTrigger>
        <SelectValue placeholder={facilityId ? '(sin trastero)' : 'Elige antes el local'} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">(sin trastero)</SelectItem>
        {(facilityId ? (units.data?.items ?? []) : []).map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.code}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const ACCESS_RESULT: Record<string, string> = {
  allowed: 'Entró',
  denied_invalid_credential: 'Código no válido',
  denied_inactive_credential: 'Acceso suspendido',
  denied_outside_hours: 'Fuera de horario',
  denied_wrong_facility: 'Otro local',
  denied_dunning: 'Cortado por impago',
  denied_unknown: 'Denegado',
  error: 'Error',
};

/** Quién ha tenido el trastero y los últimos accesos. */
function IncidentContextSection({ incidentId }: { incidentId: string }) {
  const ctx = useIncidentContext(incidentId);
  if (!ctx.data || (!ctx.data.unit && ctx.data.contracts.length === 0)) return null;
  const { unit, contracts, accessLogs } = ctx.data;
  return (
    <div className="space-y-3 rounded-md border p-3">
      <h3 className="text-sm font-medium">
        Historial{unit ? ` del trastero ${unit.code} · ${unit.facilityName}` : ''}
      </h3>
      {contracts.length > 0 && (
        <ul className="space-y-1 text-sm">
          {contracts.map((c) => (
            <li key={c.id} className="flex flex-wrap justify-between gap-2">
              <Link href={`/customers/${c.customerId}`} className="hover:underline">
                {c.customerName}
              </Link>
              <span className="text-xs text-muted-foreground">
                <Link href={`/contracts/${c.id}`} className="hover:underline">
                  {c.contractNumber}
                </Link>{' '}
                · {formatDate(c.startDate)} – {c.endDate ? formatDate(c.endDate) : 'hoy'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {accessLogs.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Últimos accesos</p>
          <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
            {accessLogs.map((l) => (
              <li key={l.id} className="flex justify-between gap-2">
                <span>
                  {formatDateTime(l.occurredAt)} · {l.customerName ?? 'Sin identificar'}
                </span>
                <span className={l.result === 'allowed' ? 'text-emerald-600' : 'text-red-600'}>
                  {ACCESS_RESULT[l.result] ?? l.result}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
