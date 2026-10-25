'use client';

import {
  type CreateMaintenancePlanInput,
  type MaintenanceFreqValue,
  type TaskPriorityValue,
  type TaskTypeValue,
  type MaintenancePlanDto,
} from '@storageos/shared';
import { CalendarClock, Loader2, Pause, Pencil, Play, Plus, Trash2, Wrench } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import { useFacilities } from '@/lib/facilities/hooks';
import {
  useCreateMaintenancePlan,
  useDeleteMaintenancePlan,
  useMaintenancePlans,
  useRunMaintenancePlan,
  useUpdateMaintenancePlan,
} from '@/lib/maintenance/hooks';

const TYPE_LABELS: Record<TaskTypeValue, string> = {
  cleaning: 'Limpieza',
  maintenance: 'Mantenimiento',
  inspection: 'Inspección',
  other: 'Otro',
};
const PRIORITY_LABELS: Record<TaskPriorityValue, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};
const WEEKDAYS = [
  { v: 1, l: 'L' },
  { v: 2, l: 'M' },
  { v: 3, l: 'X' },
  { v: 4, l: 'J' },
  { v: 5, l: 'V' },
  { v: 6, l: 'S' },
  { v: 0, l: 'D' },
];

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function MaintenancePage() {
  const ask = useConfirm();
  const canManage = useHasPermission('tasks:manage');
  const plans = useMaintenancePlans();
  const run = useRunMaintenancePlan();
  const update = useUpdateMaintenancePlan();
  const del = useDeleteMaintenancePlan();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MaintenancePlanDto | null>(null);

  async function action(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Wrench className="size-6 text-muted-foreground" />
            Mantenimiento recurrente
          </h1>
          <p className="text-sm text-muted-foreground">
            Plantillas que generan tareas automáticamente (revisiones, limpiezas, rondas…).
          </p>
        </div>
        {canManage && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-1 h-4 w-4" /> Nuevo plan
              </Button>
            </DialogTrigger>
            <PlanDialog onDone={() => setCreateOpen(false)} />
          </Dialog>
        )}
      </div>

      {plans.isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (plans.data ?? []).length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Aún no hay planes de mantenimiento. Crea uno para que el sistema genere las tareas
            automáticamente.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {(plans.data ?? []).map((p) => (
            <Card key={p.id} className={p.isActive ? '' : 'opacity-60'}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {p.title}
                    <Badge variant="secondary">{TYPE_LABELS[p.type]}</Badge>
                    {!p.isActive && <Badge variant="outline">Pausado</Badge>}
                  </CardTitle>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={run.isPending || !p.isActive}
                        onClick={() =>
                          void action(() => run.mutateAsync(p.id), 'Generación lanzada.')
                        }
                      >
                        Generar ahora
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(p)}
                        aria-label="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void action(
                            () =>
                              update.mutateAsync({ id: p.id, input: { isActive: !p.isActive } }),
                            p.isActive ? 'Plan pausado.' : 'Plan reactivado.',
                          )
                        }
                        aria-label={p.isActive ? 'Pausar' : 'Reactivar'}
                      >
                        {p.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={async () => {
                          if (
                            await ask({
                              title: `¿Eliminar el plan "${p.title}"?`,
                              destructive: true,
                            })
                          )
                            void action(() => del.mutateAsync(p.id), 'Plan eliminado.');
                        }}
                        aria-label="Eliminar"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <CalendarClock className="size-4" /> {p.scheduleLabel}
                </span>
                <span>Prioridad: {PRIORITY_LABELS[p.priority]}</span>
                {p.facilityName && <span>Local: {p.facilityName}</span>}
                {p.assignedToName && <span>Responsable: {p.assignedToName}</span>}
                <span>
                  Próxima:{' '}
                  <span className="font-medium text-foreground">{formatDate(p.nextRunDate)}</span>
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && <PlanDialog key={editing.id} plan={editing} onDone={() => setEditing(null)} />}
      </Dialog>
    </div>
  );
}

function PlanDialog({ plan, onDone }: { plan?: MaintenancePlanDto; onDone: () => void }) {
  const create = useCreateMaintenancePlan();
  const updatePlan = useUpdateMaintenancePlan();
  const facilities = useFacilities();
  const [title, setTitle] = useState(plan?.title ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [type, setType] = useState<TaskTypeValue>(plan?.type ?? 'maintenance');
  const [priority, setPriority] = useState<TaskPriorityValue>(plan?.priority ?? 'normal');
  const [facilityId, setFacilityId] = useState<string>(plan?.facilityId ?? '');
  const [freq, setFreq] = useState<MaintenanceFreqValue>(plan?.freq ?? 'monthly');
  const [interval, setIntervalValue] = useState(String(plan?.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(
    plan && plan.weekdays.length > 0 ? plan.weekdays : [1],
  );
  const [dayOfMonth, setDayOfMonth] = useState(String(plan?.dayOfMonth ?? 1));
  const today = localDateString();
  const [startDate, setStartDate] = useState(plan ? plan.nextRunDate : today);
  const [checklist, setChecklist] = useState<string[]>(
    plan?.checklistTemplate.map((c) => c.label) ?? [],
  );

  function toggleWeekday(v: number) {
    setWeekdays((prev) => (prev.includes(v) ? prev.filter((d) => d !== v) : [...prev, v]));
  }

  async function submit() {
    if (!title.trim()) {
      toast.error('Indica un título.');
      return;
    }
    const input: CreateMaintenancePlanInput = {
      title: title.trim(),
      description: description.trim(),
      type,
      priority,
      ...(facilityId ? { facilityId } : {}),
      freq,
      interval: Number(interval) || 1,
      weekdays: freq === 'weekly' ? weekdays : [],
      ...(freq === 'monthly' ? { dayOfMonth: Number(dayOfMonth) || 1 } : {}),
      checklistTemplate: checklist
        .map((l) => l.trim())
        .filter(Boolean)
        .map((label) => ({ label })),
      startDate,
    };
    try {
      if (plan) {
        const changedStart = startDate !== plan.nextRunDate;
        await updatePlan.mutateAsync({
          id: plan.id,
          input: {
            title: input.title,
            description: input.description ?? '',
            type,
            priority,
            facilityId: facilityId || null,
            freq,
            interval: input.interval,
            weekdays: input.weekdays,
            dayOfMonth: freq === 'monthly' ? (input.dayOfMonth ?? 1) : null,
            checklistTemplate: input.checklistTemplate,
            ...(changedStart ? { startDate } : {}),
          },
        });
        toast.success('Plan actualizado.');
      } else {
        await create.mutateAsync(input);
        toast.success('Plan creado.');
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el plan.');
    }
  }

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{plan ? 'Editar plan' : 'Nuevo plan de mantenimiento'}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="m-title">Título</Label>
          <Input
            id="m-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Revisión de extintores"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="m-desc">Descripción (opcional)</Label>
          <Textarea
            id="m-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Tipo</Label>
            <Select value={type} onValueChange={(v) => setType(v as TaskTypeValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TYPE_LABELS) as TaskTypeValue[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {TYPE_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Prioridad</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriorityValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRIORITY_LABELS) as TaskPriorityValue[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {PRIORITY_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Local (opcional)</Label>
          <Select
            value={facilityId || 'none'}
            onValueChange={(v) => setFacilityId(v === 'none' ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Todos / sin local" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Todos / sin local</SelectItem>
              {(facilities.data ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-md border p-3">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Frecuencia
          </Label>
          <div className="mt-2 space-y-3">
            <Select value={freq} onValueChange={(v) => setFreq(v as MaintenanceFreqValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Diaria</SelectItem>
                <SelectItem value="weekly">Semanal</SelectItem>
                <SelectItem value="monthly">Mensual</SelectItem>
              </SelectContent>
            </Select>

            {freq === 'daily' && (
              <div className="flex items-center gap-2 text-sm">
                Cada
                <Input
                  type="number"
                  min={1}
                  className="h-9 w-20"
                  value={interval}
                  onChange={(e) => setIntervalValue(e.target.value)}
                />
                día(s)
              </div>
            )}

            {freq === 'weekly' && (
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d.v}
                    type="button"
                    onClick={() => toggleWeekday(d.v)}
                    className={`size-9 rounded-md border text-sm font-medium transition-colors ${
                      weekdays.includes(d.v)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {d.l}
                  </button>
                ))}
              </div>
            )}

            {freq === 'monthly' && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                Cada
                <Input
                  type="number"
                  min={1}
                  className="h-9 w-20"
                  value={interval}
                  onChange={(e) => setIntervalValue(e.target.value)}
                />
                mes(es), el día
                <Input
                  type="number"
                  min={1}
                  max={28}
                  className="h-9 w-20"
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Checklist (opcional)
          </Label>
          <p className="text-xs text-muted-foreground">
            Puntos a comprobar en cada tarea generada (ronda de inspección). Déjalo vacío para una
            tarea simple.
          </p>
          {checklist.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={item}
                placeholder={`Punto ${i + 1}`}
                onChange={(e) =>
                  setChecklist((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setChecklist((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Quitar punto"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setChecklist((prev) => [...prev, ''])}
          >
            <Plus className="mr-1 h-4 w-4" /> Añadir punto
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label>{plan ? 'Próxima tarea a partir del' : 'Empieza el'}</Label>
          <DateSelect value={startDate} onChange={(v) => v && setStartDate(v)} future />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => void submit()} disabled={create.isPending || updatePlan.isPending}>
          {(create.isPending || updatePlan.isPending) && (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          )}
          {plan ? 'Guardar' : 'Crear plan'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
