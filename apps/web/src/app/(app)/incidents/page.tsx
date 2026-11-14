'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateIncidentInput,
  CreateIncidentSchema,
  DEFAULT_INCIDENT_RESPONSE_HOURS,
  INCIDENT_CATEGORY_LABELS,
  INSURANCE_CLAIM_STATUS_LABELS,
  type IncidentCategory,
  type IncidentResponseHours,
  type InsuranceClaimStatus,
  type IncidentDto,
  type IncidentSeverityValue,
  type IncidentStatusValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import {
  BarChart3,
  ClipboardList,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  Send,
  Timer,
} from 'lucide-react';
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
import { OpsExpenseDialog } from '@/components/operations/ops-expense-dialog';
import { OpsFiles } from '@/components/operations/ops-files';
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
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import { useIncidentContext } from '@/lib/operations/features-hooks';
import {
  useAddIncidentComment,
  useCreateIncident,
  useIncident,
  useCreateIncidentRepairTask,
  useIncidentComments,
  useIncidentRepairTasks,
  useIncidentReport,
  useIncidentResponseHours,
  useReplyIncident,
  useTransitionIncident,
  useUpdateIncident,
  useUpdateIncidentResponseHours,
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
  const [category, setCategory] = useState<IncidentCategory | undefined>();
  const [onlyLate, setOnlyLate] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const canManageIncidents = useHasPermission('incidents:manage');
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
    category,
    responseOverdue: onlyLate ? '1' : undefined,
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
        ...(values.category ? { category: values.category } : {}),
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
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => setDetailId(row.original.id)}
            className="text-left font-medium hover:underline"
          >
            {row.original.title}
          </button>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {INCIDENT_CATEGORY_LABELS[row.original.category]}
            {row.original.responseOverdue && (
              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                Sin responder, fuera de plazo
              </Badge>
            )}
            {row.original.photos.length > 0 && <span>· {row.original.photos.length} foto(s)</span>}
          </div>
        </div>
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
          <Button variant="outline" onClick={() => setReportOpen(true)}>
            <BarChart3 className="mr-1 h-4 w-4" /> Informe
          </Button>
          {canManageIncidents && (
            <Button variant="outline" onClick={() => setHoursOpen(true)}>
              <Timer className="mr-1 h-4 w-4" /> Plazos
            </Button>
          )}
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
                    <FormField
                      control={form.control}
                      name="category"
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
                              {(Object.keys(INCIDENT_CATEGORY_LABELS) as IncidentCategory[]).map(
                                (c) => (
                                  <SelectItem key={c} value={c}>
                                    {INCIDENT_CATEGORY_LABELS[c]}
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
        <Select
          value={category ?? 'all'}
          onValueChange={(v) => setCategory(v === 'all' ? undefined : (v as IncidentCategory))}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tipos</SelectItem>
            {(Object.keys(INCIDENT_CATEGORY_LABELS) as IncidentCategory[]).map((c) => (
              <SelectItem key={c} value={c}>
                {INCIDENT_CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={onlyLate ? 'default' : 'outline'}
          className="h-9"
          onClick={() => setOnlyLate((v) => !v)}
        >
          Fuera de plazo
        </Button>
      </div>

      {incidents.isError && <SectionError onRetry={() => void incidents.refetch()} />}

      <DataTable
        filtersActive={!!status || !!severity || !!category || onlyLate}
        onClearFilters={() => {
          setStatus(undefined);
          setSeverity(undefined);
          setCategory(undefined);
          setOnlyLate(false);
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
      {reportOpen && <IncidentReportDialog onClose={() => setReportOpen(false)} />}
      {hoursOpen && <ResponseHoursDialog onClose={() => setHoursOpen(false)} />}
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
  const canTasks = useHasPermission('tasks:write');
  const canExpense = useHasPermission('expenses:manage');
  const repairTasks = useIncidentRepairTasks(id);
  const createRepairTask = useCreateIncidentRepairTask(id);
  const reply = useReplyIncident(id);
  const [body, setBody] = useState('');
  const [replyText, setReplyText] = useState('');
  const [editing, setEditing] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const notFound = incident.error instanceof ApiError && incident.error.statusCode === 404;

  async function sendReply() {
    if (!replyText.trim()) return;
    try {
      await reply.mutateAsync(replyText.trim());
      setReplyText('');
      toast.success('Respuesta enviada al inquilino.');
      void incident.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  async function newRepairTask() {
    try {
      await createRepairTask.mutateAsync();
      toast.success('Tarea de reparación creada.');
      void incident.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear la tarea.');
    }
  }

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
          required: true,
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
              <div>
                <div className="text-muted-foreground">Tipo</div>
                <span>{INCIDENT_CATEGORY_LABELS[incident.data.category]}</span>
              </div>
              <div>
                <div className="text-muted-foreground">Primera respuesta</div>
                {incident.data.firstResponseAt ? (
                  <span>{formatDateTime(incident.data.firstResponseAt)}</span>
                ) : incident.data.responseDueAt ? (
                  <span
                    className={
                      incident.data.responseOverdue
                        ? 'font-medium text-red-600 dark:text-red-400'
                        : ''
                    }
                  >
                    {incident.data.responseOverdue ? 'Fuera de plazo desde ' : 'Antes del '}
                    {formatDateTime(incident.data.responseDueAt)}
                  </span>
                ) : (
                  <span>—</span>
                )}
              </div>
              {(incident.data.cost !== null || incident.data.insuranceClaimStatus) && (
                <div>
                  <div className="text-muted-foreground">Coste y seguro</div>
                  <span>
                    {[
                      incident.data.cost !== null ? formatEur(incident.data.cost) : null,
                      incident.data.insuranceClaimStatus
                        ? `${INSURANCE_CLAIM_STATUS_LABELS[incident.data.insuranceClaimStatus]}${
                            incident.data.insuranceClaimRef
                              ? ` (${incident.data.insuranceClaimRef})`
                              : ''
                          }${
                            incident.data.insuranceClaimAmount !== null
                              ? ` · ${formatEur(incident.data.insuranceClaimAmount)}`
                              : ''
                          }`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              )}
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

            <OpsFiles
              files={incident.data.photos}
              basePath={`/incidents/${incident.data.id}/photos`}
              canEdit={canWrite}
              onChanged={() => void incident.refetch()}
            />

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Reparación</h3>
                <div className="flex flex-wrap gap-2">
                  {canTasks && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={createRepairTask.isPending}
                      onClick={() => void newRepairTask()}
                    >
                      <ClipboardList className="mr-1 h-4 w-4" /> Crear tarea
                    </Button>
                  )}
                  {canExpense && !incident.data.expenseId && (
                    <Button size="sm" variant="outline" onClick={() => setExpenseOpen(true)}>
                      <Receipt className="mr-1 h-4 w-4" /> Apuntar el gasto
                    </Button>
                  )}
                </div>
              </div>
              {incident.data.expenseId && (
                <p className="text-sm text-muted-foreground">
                  Gasto apuntado ·{' '}
                  <Link href="/expenses" className="text-primary hover:underline">
                    Ver en Gastos
                  </Link>
                </p>
              )}
              {(repairTasks.data ?? []).length > 0 ? (
                <ul className="space-y-1">
                  {repairTasks.data!.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/tasks?task=${t.id}`}
                        className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                      >
                        <span className="truncate">{t.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {[t.assignedToName, t.dueDate ? formatDate(t.dueDate) : null]
                            .filter(Boolean)
                            .join(' · ')}{' '}
                          · {TASK_STATUS_TEXT[t.status] ?? t.status}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Sin tareas de reparación.</p>
              )}
            </div>

            {incident.data.customerId && canWrite && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Responder al inquilino</h3>
                <p className="text-xs text-muted-foreground">
                  Le llega a su chat del área de clientes y queda en los comentarios.
                </p>
                <div className="flex gap-2">
                  <Textarea
                    rows={2}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Ya hemos visto la gotera y mañana viene el técnico…"
                  />
                  <Button
                    size="sm"
                    aria-label="Enviar al inquilino"
                    onClick={() => void sendReply()}
                    disabled={!replyText.trim() || reply.isPending}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
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
      {expenseOpen && incident.data && (
        <OpsExpenseDialog
          path={`/incidents/${incident.data.id}/expense`}
          title={incident.data.title}
          defaultAmount={incident.data.cost}
          onClose={() => setExpenseOpen(false)}
          onDone={() => {
            setExpenseOpen(false);
            void incident.refetch();
          }}
        />
      )}
    </Dialog>
  );
}

const TASK_STATUS_TEXT: Record<string, string> = {
  open: 'Abierta',
  in_progress: 'En curso',
  done: 'Hecha',
  cancelled: 'Cancelada',
};

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
  const [category, setCategory] = useState<IncidentCategory>(incident.category);
  const [cost, setCost] = useState(incident.cost !== null ? String(incident.cost) : '');
  const [claimStatus, setClaimStatus] = useState<string>(incident.insuranceClaimStatus ?? 'none');
  const [claimRef, setClaimRef] = useState(incident.insuranceClaimRef ?? '');
  const [claimAmount, setClaimAmount] = useState(
    incident.insuranceClaimAmount !== null ? String(incident.insuranceClaimAmount) : '',
  );
  const num = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null);

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
        category,
        cost: num(cost),
        insuranceClaimStatus: claimStatus === 'none' ? null : (claimStatus as InsuranceClaimStatus),
        insuranceClaimRef: claimStatus === 'none' ? null : claimRef.trim() || null,
        insuranceClaimAmount: claimStatus === 'none' ? null : num(claimAmount),
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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Tipo</Label>
          <Select value={category} onValueChange={(v) => setCategory(v as IncidentCategory)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(INCIDENT_CATEGORY_LABELS) as IncidentCategory[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {INCIDENT_CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="inc-edit-cost">Coste de la reparación</Label>
          <Input
            id="inc-edit-cost"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>Parte al seguro</Label>
          <Select value={claimStatus} onValueChange={setClaimStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sin parte</SelectItem>
              {(Object.keys(INSURANCE_CLAIM_STATUS_LABELS) as InsuranceClaimStatus[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {INSURANCE_CLAIM_STATUS_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {claimStatus !== 'none' && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="inc-claim-ref">Nº de parte</Label>
              <Input
                id="inc-claim-ref"
                value={claimRef}
                onChange={(e) => setClaimRef(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="inc-claim-amount">Importe</Label>
              <Input
                id="inc-claim-amount"
                inputMode="decimal"
                value={claimAmount}
                onChange={(e) => setClaimAmount(e.target.value)}
              />
            </div>
          </div>
        )}
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

const SEVERITY_ORDER: IncidentSeverityValue[] = ['critical', 'high', 'medium', 'low'];

function ResponseHoursDialog({ onClose }: { onClose: () => void }) {
  const hours = useIncidentResponseHours();
  const save = useUpdateIncidentResponseHours();
  const [draft, setDraft] = useState<Record<IncidentSeverityValue, string> | null>(null);
  const current = hours.data ?? DEFAULT_INCIDENT_RESPONSE_HOURS;
  const value = (s: IncidentSeverityValue) => draft?.[s] ?? String(current[s]);

  async function submit() {
    const next = {} as IncidentResponseHours;
    for (const s of SEVERITY_ORDER) {
      const n = Number(value(s));
      if (!Number.isInteger(n) || n < 1 || n > 720) {
        toast.error('Cada plazo, entre 1 y 720 horas.');
        return;
      }
      next[s] = n;
    }
    try {
      await save.mutateAsync(next);
      toast.success('Plazos guardados.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Plazos de respuesta</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Horas para dar la primera respuesta (un comentario, pasarla a «En investigación» o
          contestar al inquilino). Las que se pasen salen como «Fuera de plazo».
        </p>
        <div className="space-y-2">
          {SEVERITY_ORDER.map((s) => (
            <div key={s} className="flex items-center justify-between gap-3">
              <Label htmlFor={`hours-${s}`}>{SEVERITY_LABELS[s].label}</Label>
              <div className="flex items-center gap-2 text-sm">
                <Input
                  id={`hours-${s}`}
                  type="number"
                  min={1}
                  max={720}
                  className="h-9 w-24"
                  value={value(s)}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...(d ?? {
                        critical: String(current.critical),
                        high: String(current.high),
                        medium: String(current.medium),
                        low: String(current.low),
                      }),
                      [s]: e.target.value,
                    }))
                  }
                />
                horas
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function IncidentReportDialog({ onClose }: { onClose: () => void }) {
  const [from, setFrom] = useState(daysAgo(89));
  const [to, setTo] = useState(daysAgo(0));
  const report = useIncidentReport(from, to);
  const r = report.data;
  const table = (
    title: string,
    rows: { key: string; label: string; count: number; open: number }[],
  ) => (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        <ul className="text-sm">
          {rows.map((row) => (
            <li key={row.key} className="flex justify-between gap-2 border-b py-1 last:border-0">
              <span>{row.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {row.count}
                {row.open > 0 ? ` · ${row.open} abiertas` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Informe de incidencias</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div className="space-y-1">
            <Label>Desde</Label>
            <DateSelect around value={from} onChange={(v) => v && setFrom(v)} />
          </div>
          <div className="space-y-1">
            <Label>Hasta</Label>
            <DateSelect around value={to} onChange={(v) => v && setTo(v)} />
          </div>
        </div>
        {report.isError ? (
          <SectionError onRetry={() => void report.refetch()} />
        ) : !r ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              {[
                { label: 'Reportadas', value: String(r.total) },
                { label: 'Abiertas', value: String(r.open) },
                {
                  label: 'Horas hasta resolver',
                  value: r.avgResolutionHours === null ? '—' : String(r.avgResolutionHours),
                },
                {
                  label: 'Respondidas a tiempo',
                  value: r.withinResponsePct === null ? '—' : `${r.withinResponsePct}%`,
                },
              ].map((k) => (
                <div key={k.label} className="rounded-md border p-2">
                  <div className="text-lg font-semibold">{k.value}</div>
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Coste de las reparaciones: {formatEur(r.totalCost)} · Partes al seguro:{' '}
              {r.insuranceClaims}
            </p>
            {table('Por tipo', r.byCategory)}
            {table('Por gravedad', r.bySeverity)}
            {table('Por local', r.byFacility)}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
