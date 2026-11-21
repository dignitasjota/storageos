'use client';

import {
  DayHoursSchema,
  MAX_CLOSED_DATES,
  TeamHoursSchema,
  WEEKDAYS,
  type DayHours,
  type TeamHours,
  type Weekday,
} from '@storageos/shared';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { localDateString } from '@/lib/dates';

const DAY_LABELS: Record<Weekday, string> = {
  mon: 'Lunes',
  tue: 'Martes',
  wed: 'Miércoles',
  thu: 'Jueves',
  fri: 'Viernes',
  sat: 'Sábado',
  sun: 'Domingo',
};

/** Primer problema del horario (para no dejar guardar), o null si está bien. */
export function teamHoursIssue(value: TeamHours): string | null {
  for (const day of WEEKDAYS) {
    const v = value[day];
    if (!v) continue;
    const parsed = DayHoursSchema.safeParse(v);
    if (!parsed.success) {
      return `${DAY_LABELS[day]}: ${parsed.error.issues[0]?.message ?? 'horario no válido'}`;
    }
  }
  const all = TeamHoursSchema.safeParse(value);
  return all.success ? null : (all.error.issues[0]?.message ?? 'Horario no válido');
}

function dayIssue(v: DayHours): string | null {
  const parsed = DayHoursSchema.safeParse(v);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Horario no válido');
}

/** «jue, 25 dic 2026». */
function closedDateLabel(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Horario de atención del equipo: las horas de cada día (un día sin marcar queda
 * cerrado), un segundo turno opcional para el horario partido y los días
 * cerrados (festivos, vacaciones), que cuentan como fuera de horario todo el día.
 * Se usa en Mensajes, el asistente de WhatsApp y el chat de la web.
 */
export function TeamHoursEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: TeamHours;
  onChange: (hours: TeamHours) => void;
  disabled?: boolean;
}) {
  const [newDate, setNewDate] = useState<string | undefined>(undefined);
  const today = localDateString();
  const closed = value.closedDates ?? [];

  const setDay = (day: Weekday, hours: DayHours | null) => onChange({ ...value, [day]: hours });

  function addClosedDate() {
    if (!newDate || closed.includes(newDate)) return;
    onChange({ ...value, closedDates: [...closed, newDate].sort() });
    setNewDate(undefined);
  }

  function removeClosedDate(d: string) {
    const rest = closed.filter((x) => x !== d);
    if (rest.length > 0) {
      onChange({ ...value, closedDates: rest });
    } else {
      const { closedDates: _closedDates, ...without } = value;
      onChange(without);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {WEEKDAYS.map((day) => {
          const v = value[day];
          const issue = v ? dayIssue(v) : null;
          const split = !!v && (v.open2 !== undefined || v.close2 !== undefined);
          return (
            <div key={day} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex w-28 items-center gap-2">
                  <Checkbox
                    checked={!!v}
                    disabled={disabled}
                    onCheckedChange={(c) =>
                      setDay(day, c === true ? { open: '09:00', close: '18:00' } : null)
                    }
                  />
                  {DAY_LABELS[day]}
                </label>
                {v ? (
                  <>
                    <TimeRange
                      day={DAY_LABELS[day]}
                      open={v.open}
                      close={v.close}
                      disabled={disabled}
                      onChange={(open, close) => setDay(day, { ...v, open, close })}
                    />
                    {split ? (
                      <>
                        <span className="text-muted-foreground">y</span>
                        <TimeRange
                          day={`${DAY_LABELS[day]} (segundo turno)`}
                          open={v.open2 ?? ''}
                          close={v.close2 ?? ''}
                          disabled={disabled}
                          onChange={(open2, close2) => setDay(day, { ...v, open2, close2 })}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={disabled}
                          aria-label={`Quitar el segundo turno del ${DAY_LABELS[day].toLowerCase()}`}
                          onClick={() => setDay(day, { open: v.open, close: v.close })}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground"
                        disabled={disabled}
                        onClick={() =>
                          setDay(
                            day,
                            // Lo más habitual: mañana y tarde.
                            v.open < '14:00'
                              ? { open: v.open, close: '14:00', open2: '16:00', close2: '20:00' }
                              : { ...v, open2: '', close2: '' },
                          )
                        }
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" /> Turno partido
                      </Button>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">Cerrado</span>
                )}
              </div>
              {issue && <p className="pl-1 text-xs text-destructive sm:pl-[7.5rem]">{issue}</p>}
            </div>
          );
        })}
      </div>

      <div className="space-y-2 border-t pt-3">
        <div>
          <p className="text-sm font-medium">Días cerrados</p>
          <p className="text-xs text-muted-foreground">
            Festivos o vacaciones: esos días cuentan como fuera de horario aunque sea un día
            marcado. Los que ya han pasado se quitan solos al guardar.
          </p>
        </div>
        {closed.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {closed.map((d) => (
              <li
                key={d}
                className={`inline-flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-xs ${
                  d < today ? 'text-muted-foreground line-through' : ''
                }`}
              >
                {closedDateLabel(d)}
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-muted disabled:opacity-50"
                  disabled={disabled}
                  aria-label={`Quitar ${closedDateLabel(d)}`}
                  onClick={() => removeClosedDate(d)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {closed.length < MAX_CLOSED_DATES ? (
          <div className="flex flex-wrap items-center gap-2">
            <DateSelect value={newDate} onChange={setNewDate} future years={2} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !newDate || closed.includes(newDate) || newDate < today}
              onClick={addClosedDate}
            >
              Añadir día cerrado
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Has llegado al máximo de {MAX_CLOSED_DATES} días cerrados.
          </p>
        )}
      </div>
    </div>
  );
}

function TimeRange({
  day,
  open,
  close,
  disabled,
  onChange,
}: {
  day: string;
  open: string;
  close: string;
  disabled: boolean;
  onChange: (open: string, close: string) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        type="time"
        aria-label={`${day}: abre`}
        value={open}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value, close)}
        className="h-8 w-28 text-base sm:text-sm"
      />
      <span>a</span>
      <Input
        type="time"
        aria-label={`${day}: cierra`}
        value={close}
        disabled={disabled}
        onChange={(e) => onChange(open, e.target.value)}
        className="h-8 w-28 text-base sm:text-sm"
      />
    </span>
  );
}
