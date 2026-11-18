'use client';

import {
  SALES_APPOINTMENT_DURATIONS,
  SALES_APPOINTMENT_KIND_LABELS,
  SALES_APPOINTMENT_STATUS_LABELS,
  type SalesAppointmentDto,
  type CreateSalesAppointmentInput,
  type SalesAppointmentKind,
  type UpdateSalesAppointmentInput,
} from '@storageos/shared';
import {
  CalendarClock,
  Check,
  MapPin,
  MoreHorizontal,
  Pencil,
  Phone,
  Trash2,
  Users,
  Video,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { addDaysIso, errorText, todayInSpain } from '@/components/admin/sales/common';
import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const TZ = 'Europe/Madrid';

// ------------------------------------------------------------------- fechas

/** Fecha y hora de España (AAAA-MM-DD + HH:MM) como instante ISO. */
export function madridIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  let t = wanted;
  // Dos pasadas bastan también en el cambio de hora.
  for (let i = 0; i < 2; i += 1) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
    );
    t += wanted - shown;
  }
  return new Date(t).toISOString();
}

/** Partes en hora de España de un instante ISO. */
function madridParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = d.toLocaleDateString('sv-SE', { timeZone: TZ });
  const time = new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return { date, time };
}

/** «Hoy · 10:30», «Mañana · 09:00» o «jue 20 nov · 17:15». */
export function appointmentLabel(iso: string): string {
  const { date, time } = madridParts(iso);
  const today = todayInSpain();
  if (date === today) return `Hoy · ${time}`;
  if (date === addDaysIso(today, 1)) return `Mañana · ${time}`;
  const day = new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
  }).format(new Date(iso));
  return `${day} · ${time}`;
}

const HOURS = Array.from({ length: 17 }, (_, i) => String(i + 7).padStart(2, '0'));
const MINUTES = ['00', '15', '30', '45'];

const KIND_ICON: Record<SalesAppointmentKind, typeof Phone> = {
  in_person: Users,
  call: Phone,
  video: Video,
};

const STATUS_VARIANT: Record<SalesAppointmentDto['status'], 'secondary' | 'outline'> = {
  scheduled: 'secondary',
  done: 'outline',
  cancelled: 'outline',
  no_show: 'outline',
};

// ----------------------------------------------------------------- formulario

export interface AppointmentFormValues {
  kind: SalesAppointmentKind;
  title: string;
  startsAt: string;
  durationMinutes: number;
  location: string;
  notes: string;
  repId?: string;
}

/**
 * Alta o cambio de una cita. Con `reps` (la dirección) también se elige el
 * comercial.
 */
export function AppointmentDialog({
  open,
  onClose,
  initial,
  reps,
  defaultRepId,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  initial?: SalesAppointmentDto | null;
  reps?: { id: string; fullName: string }[];
  defaultRepId?: string | null;
  onSubmit: (values: AppointmentFormValues) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {open && (
          <AppointmentForm
            initial={initial ?? null}
            reps={reps}
            defaultRepId={defaultRepId ?? null}
            onClose={onClose}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AppointmentForm({
  initial,
  reps,
  defaultRepId,
  onClose,
  onSubmit,
}: {
  initial: SalesAppointmentDto | null;
  reps?: { id: string; fullName: string }[];
  defaultRepId: string | null;
  onClose: () => void;
  onSubmit: (values: AppointmentFormValues) => Promise<void>;
}) {
  const start = initial ? madridParts(initial.startsAt) : null;
  const [kind, setKind] = useState<SalesAppointmentKind>(initial?.kind ?? 'call');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(start?.date ?? addDaysIso(todayInSpain(), 1));
  const [hour, setHour] = useState(start?.time.slice(0, 2) ?? '10');
  const [minute, setMinute] = useState(
    start && MINUTES.includes(start.time.slice(3, 5)) ? start.time.slice(3, 5) : '00',
  );
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 30));
  const [location, setLocation] = useState(initial?.location ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [repId, setRepId] = useState(
    initial?.repId ??
      (defaultRepId && reps?.some((r) => r.id === defaultRepId) ? defaultRepId : ''),
  );
  const [saving, setSaving] = useState(false);
  // Las horas que no están en la lista (p. ej. 06:00) se conservan al editar.
  const hours = HOURS.includes(hour) ? HOURS : [hour, ...HOURS].sort();
  const durations = SALES_APPOINTMENT_DURATIONS.map(String).includes(duration)
    ? SALES_APPOINTMENT_DURATIONS.map(String)
    : [duration, ...SALES_APPOINTMENT_DURATIONS.map(String)];
  const placeholder =
    kind === 'video'
      ? 'Enlace de la videollamada'
      : kind === 'call'
        ? 'Teléfono (si no es el de la ficha)'
        : 'Dirección';
  const canSave = title.trim().length >= 2 && !!date && (!reps || !!repId) && !saving;

  async function save() {
    setSaving(true);
    try {
      await onSubmit({
        kind,
        title: title.trim(),
        startsAt: madridIso(date, `${hour}:${minute}`),
        durationMinutes: Number(duration),
        location: location.trim(),
        notes: notes.trim(),
        ...(reps ? { repId } : {}),
      });
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{initial ? 'Cambiar la cita' : 'Nueva cita'}</DialogTitle>
        <DialogDescription>
          {reps
            ? 'Al comercial le llega un aviso ahora, el día antes y una hora antes.'
            : 'Te avisamos el día antes y una hora antes (campana y móvil).'}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {reps && (
          <div className="space-y-1.5">
            <Label htmlFor="appt-rep">Comercial</Label>
            <Select value={repId} onValueChange={setRepId}>
              <SelectTrigger id="appt-rep">
                <SelectValue placeholder="Elige el comercial" />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="appt-kind">Tipo</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as SalesAppointmentKind)}>
              <SelectTrigger id="appt-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SALES_APPOINTMENT_KIND_LABELS) as SalesAppointmentKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SALES_APPOINTMENT_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="appt-title">Asunto</Label>
            <Input
              id="appt-title"
              value={title}
              maxLength={200}
              placeholder="Demo del panel, visita al local…"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Día</Label>
          <DateSelect value={date} onChange={(v) => setDate(v ?? date)} future />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="appt-hour">Hora</Label>
            <div className="flex items-center gap-1">
              <Select value={hour} onValueChange={setHour}>
                <SelectTrigger id="appt-hour" className="w-20" aria-label="Hora">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hours.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span aria-hidden>:</span>
              <Select value={minute} onValueChange={setMinute}>
                <SelectTrigger className="w-20" aria-label="Minutos">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="appt-duration">Duración</Label>
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger id="appt-duration" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {durations.map((d) => (
                  <SelectItem key={d} value={d}>
                    {Number(d) < 60
                      ? `${d} min`
                      : `${Number(d) / 60} h`.replace('.5 h', ' h y media')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="appt-location">
            {kind === 'video' ? 'Enlace' : kind === 'call' ? 'Teléfono' : 'Lugar'}
          </Label>
          <Input
            id="appt-location"
            value={location}
            maxLength={500}
            placeholder={placeholder}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="appt-notes">Notas</Label>
          <Textarea
            id="appt-notes"
            rows={3}
            value={notes}
            maxLength={2000}
            placeholder="Qué preparar, quién estará…"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button disabled={!canSave} onClick={() => void save()}>
          {initial ? 'Guardar' : 'Poner la cita'}
        </Button>
      </DialogFooter>
    </>
  );
}

// --------------------------------------------------------------------- lista

function LocationLine({ appt }: { appt: SalesAppointmentDto }) {
  const loc = appt.location;
  if (loc && /^https?:\/\//i.test(loc)) {
    return (
      <a
        href={loc}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 truncate text-primary hover:underline"
      >
        <Video className="size-3 shrink-0" aria-hidden />
        Abrir la videollamada
      </a>
    );
  }
  const phone = appt.kind === 'call' ? loc || appt.leadPhone : null;
  if (phone) {
    return (
      <a
        href={`tel:${phone.replace(/\s+/g, '')}`}
        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
      >
        <Phone className="size-3 shrink-0" aria-hidden />
        {phone}
      </a>
    );
  }
  if (loc) {
    return (
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-w-0 items-center gap-1 hover:text-foreground hover:underline"
      >
        <MapPin className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{loc}</span>
      </a>
    );
  }
  return null;
}

/**
 * Lista de citas con sus acciones. `leadHref` enlaza el nombre del cliente y
 * `showRep` enseña de qué comercial es (para la dirección).
 */
export function AppointmentList({
  items,
  leadHref,
  showRep = false,
  onUpdate,
  onDelete,
  onEdit,
  empty = 'No hay citas.',
}: {
  items: SalesAppointmentDto[];
  leadHref?: (a: SalesAppointmentDto) => string;
  showRep?: boolean;
  onUpdate: (id: string, input: UpdateSalesAppointmentInput) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onEdit: (a: SalesAppointmentDto) => void;
  empty?: string;
}) {
  const confirm = useConfirm();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;

  const act = (id: string, input: UpdateSalesAppointmentInput, ok: string) =>
    void onUpdate(id, input)
      .then(() => toast.success(ok))
      .catch((e: unknown) => toast.error(errorText(e)));

  return (
    <ul className="divide-y">
      {items.map((a) => {
        const Icon = KIND_ICON[a.kind];
        const past = new Date(a.startsAt).getTime() < Date.now();
        const open = a.status === 'scheduled';
        return (
          <li key={a.id} className="flex items-start gap-3 py-2.5">
            <span
              className={cn(
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                open && !past ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    'font-medium',
                    open && past && 'text-rose-600 dark:text-rose-400',
                    !open && 'text-muted-foreground line-through decoration-1',
                  )}
                >
                  {appointmentLabel(a.startsAt)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {SALES_APPOINTMENT_KIND_LABELS[a.kind]} · {a.durationMinutes} min
                </span>
                {!open && (
                  <Badge variant={STATUS_VARIANT[a.status]} className="text-[10px]">
                    {SALES_APPOINTMENT_STATUS_LABELS[a.status]}
                  </Badge>
                )}
              </div>
              <p className="min-w-0">
                {leadHref ? (
                  <Link href={leadHref(a)} className="font-medium hover:underline">
                    {a.leadName}
                  </Link>
                ) : null}
                {leadHref ? ' · ' : ''}
                {a.title}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <LocationLine appt={a} />
                {showRep && <span>Comercial: {a.repName}</span>}
                {!showRep && a.createdByOther && a.createdByName && (
                  <span>Te la puso {a.createdByName}</span>
                )}
              </div>
              {a.notes && (
                <p className="whitespace-pre-line text-xs text-muted-foreground">{a.notes}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {open && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => act(a.id, { status: 'done' }, 'Cita hecha.')}
                >
                  <Check className="size-4" aria-hidden />
                  <span className="sr-only sm:not-sr-only sm:ml-1">Hecha</span>
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="size-8" aria-label="Más opciones">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onEdit(a)}>
                    <Pencil className="mr-2 size-4" aria-hidden />
                    {open ? 'Cambiar' : 'Cambiar o reabrir'}
                  </DropdownMenuItem>
                  {open && (
                    <>
                      <DropdownMenuItem
                        onSelect={() => act(a.id, { status: 'no_show' }, 'Anotado.')}
                      >
                        <CalendarClock className="mr-2 size-4" aria-hidden />
                        No se presentó
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => act(a.id, { status: 'cancelled' }, 'Cita cancelada.')}
                      >
                        Cancelar la cita
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={async () => {
                      if (
                        !(await confirm({
                          title: 'Borrar esta cita',
                          description:
                            'Desaparece de la lista. Si solo no se va a hacer, mejor cancélala.',
                          confirmLabel: 'Borrar',
                          destructive: true,
                        }))
                      )
                        return;
                      void onDelete(a.id).catch((e: unknown) => toast.error(errorText(e)));
                    }}
                  >
                    <Trash2 className="mr-2 size-4" aria-hidden />
                    Borrar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Lo que se manda al cambiar una cita desde el formulario. */
export function updateFromForm(v: AppointmentFormValues): UpdateSalesAppointmentInput {
  return {
    kind: v.kind,
    title: v.title,
    startsAt: v.startsAt,
    durationMinutes: v.durationMinutes,
    location: v.location,
    notes: v.notes,
  };
}

/** Lo que se manda al crear una cita desde el formulario. */
export function createFromForm(v: AppointmentFormValues): CreateSalesAppointmentInput {
  return {
    kind: v.kind,
    title: v.title,
    startsAt: v.startsAt,
    durationMinutes: v.durationMinutes,
    location: v.location,
    notes: v.notes,
  };
}
