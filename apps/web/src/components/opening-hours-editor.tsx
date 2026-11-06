'use client';

import { WEEKDAYS, type OpeningHours, type Weekday } from '@storageos/shared';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

const DAY_LABELS: Record<Weekday, string> = {
  mon: 'Lunes',
  tue: 'Martes',
  wed: 'Miércoles',
  thu: 'Jueves',
  fri: 'Viernes',
  sat: 'Sábado',
  sun: 'Domingo',
};

/** Horas de cada día; un día sin marcar queda cerrado. */
export function OpeningHoursEditor({
  value,
  onChange,
}: {
  value: OpeningHours;
  onChange: (hours: OpeningHours) => void;
}) {
  return (
    <div className="space-y-1.5">
      {WEEKDAYS.map((day: Weekday) => {
        const v = value[day];
        return (
          <div key={day} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex w-28 items-center gap-2">
              <Checkbox
                checked={!!v}
                onCheckedChange={(c) =>
                  onChange({
                    ...value,
                    [day]: c === true ? { open: '09:00', close: '18:00' } : null,
                  })
                }
              />
              {DAY_LABELS[day]}
            </label>
            {v && (
              <>
                <Input
                  type="time"
                  value={v.open}
                  onChange={(e) => onChange({ ...value, [day]: { ...v, open: e.target.value } })}
                  className="h-8 w-28 text-base sm:text-sm"
                />
                <span>a</span>
                <Input
                  type="time"
                  value={v.close}
                  onChange={(e) => onChange({ ...value, [day]: { ...v, close: e.target.value } })}
                  className="h-8 w-28 text-base sm:text-sm"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
