'use client';

import { LEAD_VISIT_STATUS_LABELS, type LeadDto } from '@storageos/shared';
import { CalendarPlus, Check, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import {
  useCreateLeadVisit,
  useDeleteLeadVisit,
  useLeadVisits,
  useUpdateLeadVisit,
} from '@/lib/leads/hooks';

const NONE = '__none';
const HOURS = Array.from({ length: 27 }, (_, i) => {
  const minutes = 8 * 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

/**
 * Visitas al local: se programan (salen en el calendario y el contacto recibe
 * un recordatorio el día antes) y se marcan hechas o «no vino».
 */
export function LeadVisits({ lead }: { lead: LeadDto }) {
  const ask = useConfirm();
  const canWrite = useHasPermission('leads:write');
  const visits = useLeadVisits(lead.id);
  const facilities = useFacilities();
  const create = useCreateLeadVisit(lead.id);
  const update = useUpdateLeadVisit();
  const remove = useDeleteLeadVisit();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(tomorrow());
  const [time, setTime] = useState('11:00');
  const [facilityId, setFacilityId] = useState(lead.preferredFacilityId ?? NONE);
  const [notes, setNotes] = useState('');

  const list = visits.data ?? [];
  if (!canWrite && list.length === 0) return null;

  const schedule = () => {
    // Hora del navegador (la del local en casi todos los casos).
    const at = new Date(`${date}T${time}:00`);
    create.mutate(
      {
        scheduledAt: at.toISOString(),
        ...(facilityId !== NONE ? { facilityId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success(
            lead.email
              ? 'Visita programada. Le recordaremos la cita el día antes.'
              : 'Visita programada.',
          );
          setOpen(false);
          setNotes('');
        },
        onError: (err) => toast.error(errorText(err, 'No se ha podido programar')),
      },
    );
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Visitas al local</p>
        {canWrite && !open && (
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            <CalendarPlus className="mr-1 size-4" /> Programar visita
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1">
              <Label className="text-xs">Día</Label>
              <DateSelect future value={date} onChange={(v) => setDate(v ?? tomorrow())} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="visit-time" className="text-xs">
                Hora
              </Label>
              <Select value={time} onValueChange={setTime}>
                <SelectTrigger id="visit-time" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="visit-facility" className="text-xs">
              Local
            </Label>
            <Select value={facilityId} onValueChange={setFacilityId}>
              <SelectTrigger id="visit-facility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin local</SelectItem>
                {(facilities.data ?? [])
                  .filter((f) => f.isActive)
                  .map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Nota (opcional)"
            value={notes}
            maxLength={1000}
            onChange={(e) => setNotes(e.target.value)}
            aria-label="Nota de la visita"
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={create.isPending} onClick={schedule}>
              Programar
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {list.length > 0 && (
        <ul className="divide-y rounded-md border">
          {list.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {new Date(v.scheduledAt).toLocaleString('es-ES', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {v.facilityName ? ` · ${v.facilityName}` : ''}
                </p>
                <p className="text-muted-foreground">
                  {LEAD_VISIT_STATUS_LABELS[v.status]}
                  {v.userName ? ` · ${v.userName}` : ''}
                  {v.notes ? ` · ${v.notes}` : ''}
                </p>
              </div>
              {canWrite && v.status === 'scheduled' && (
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      update.mutate(
                        { id: v.id, status: 'done' },
                        {
                          onSuccess: () =>
                            toast.success('Hecha. Tienes un seguimiento para mañana.'),
                          onError: (err) => toast.error(errorText(err, 'No se ha podido guardar')),
                        },
                      )
                    }
                  >
                    <Check className="mr-1 size-3.5" /> Vino
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      update.mutate(
                        { id: v.id, status: 'no_show' },
                        {
                          onError: (err) => toast.error(errorText(err, 'No se ha podido guardar')),
                        },
                      )
                    }
                  >
                    <X className="mr-1 size-3.5" /> No vino
                  </Button>
                </div>
              )}
              {canWrite && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label="Borrar la visita"
                  onClick={async () => {
                    if (
                      await ask({
                        title: '¿Borrar esta visita?',
                        confirmLabel: 'Borrar',
                        destructive: true,
                      })
                    ) {
                      remove.mutate(v.id);
                    }
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
