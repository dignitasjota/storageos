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
import { Loader2, Plus } from 'lucide-react';
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
import { useCustomers } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import {
  useAddIncidentComment,
  useCreateIncident,
  useIncident,
  useIncidentComments,
  useIncidents,
  useTransitionIncident,
} from '@/lib/operations/hooks';

const SEVERITY_LABELS: Record<IncidentSeverityValue, { label: string; className: string }> = {
  low: { label: 'Baja', className: 'bg-slate-100 text-slate-700' },
  medium: { label: 'Media', className: 'bg-blue-100 text-blue-700' },
  high: { label: 'Alta', className: 'bg-orange-100 text-orange-700' },
  critical: { label: 'Crítica', className: 'bg-red-100 text-red-700' },
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
  resolved: [],
  dismissed: [],
};

export default function IncidentsPage() {
  const [status, setStatus] = useState<IncidentStatusValue | undefined>();
  const [severity, setSeverity] = useState<IncidentSeverityValue | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const incidents = useIncidents({
    ...(status ? { status } : {}),
    ...(severity ? { severity } : {}),
  });
  const facilities = useFacilities();
  const customers = useCustomers();
  const create = useCreateIncident();

  const form = useForm<CreateIncidentInput>({
    resolver: zodResolver(CreateIncidentSchema),
    defaultValues: {
      severity: 'medium',
      title: '',
      description: '',
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
      cell: ({ row }) => row.original.customerName ?? '—',
    },
    {
      accessorKey: 'facilityName',
      header: 'Local',
      cell: ({ row }) => row.original.facilityName ?? '—',
    },
    {
      accessorKey: 'createdAt',
      header: 'Reportada',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString('es-ES'),
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Incidencias</h1>
        <p className="text-sm text-muted-foreground">
          Robos, daños, quejas o cualquier evento que requiera atención.
        </p>
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

      <DataTable
        columns={columns}
        data={incidents.data ?? []}
        isLoading={incidents.isLoading}
        searchPlaceholder="Buscar por título..."
        emptyText="No hay incidencias registradas."
        toolbarRight={
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
                            <Select
                              onValueChange={(v) => field.onChange(v === 'none' ? undefined : v)}
                              value={field.value ?? 'none'}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="(sin inquilino)" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="none">(sin inquilino)</SelectItem>
                                {(customers.data ?? []).map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    {c.displayName}
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

      {detailId && <IncidentDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function IncidentDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const incident = useIncident(id);
  const comments = useIncidentComments(id);
  const transition = useTransitionIncident();
  const addComment = useAddIncidentComment(id);
  const [body, setBody] = useState('');

  async function handleTransition(next: IncidentStatusValue) {
    try {
      await transition.mutateAsync({ id, input: { status: next } });
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
          <DialogTitle>{incident.data?.title ?? 'Cargando...'}</DialogTitle>
        </DialogHeader>
        {incident.isLoading || !incident.data ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
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
              </div>
            </div>
            {incident.data.description && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                {incident.data.description}
              </div>
            )}

            {NEXT_STATUS[incident.data.status].length > 0 && (
              <div className="flex flex-wrap gap-2">
                {NEXT_STATUS[incident.data.status].map((next) => (
                  <Button
                    key={next}
                    size="sm"
                    variant={next === 'dismissed' ? 'outline' : 'default'}
                    onClick={() => handleTransition(next)}
                    disabled={transition.isPending}
                  >
                    Marcar como {STATUS_LABELS[next].label.toLowerCase()}
                  </Button>
                ))}
              </div>
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
