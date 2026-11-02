'use client';

import { DateSelect } from '@/components/month-year-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const HOURS = Array.from({ length: 24 * 2 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 === 0 ? '00' : '30';
  return `${String(h).padStart(2, '0')}:${m}`;
});

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO → partes en la hora del navegador. */
function split(value: string | null): { date: string | undefined; time: string } {
  if (!value) return { date: undefined, time: '09:00' };
  const d = new Date(value);
  const mins = d.getMinutes() < 30 ? '00' : '30';
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${mins}`,
  };
}

/**
 * Día y hora (cada media hora) con desplegables, en la hora de quien lo usa.
 * Devuelve un ISO con zona; sin día, null. (Los `<input type="datetime-local">`
 * no funcionan igual en todos los navegadores.)
 */
export function DateTimeSelect({
  value,
  onChange,
  future = true,
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  future?: boolean;
}) {
  const { date, time } = split(value);
  const emit = (d: string | undefined, t: string) => {
    if (!d) return onChange(null);
    const [y, m, day] = d.split('-').map(Number);
    const [h, min] = t.split(':').map(Number);
    onChange(new Date(y ?? 0, (m ?? 1) - 1, day ?? 1, h ?? 0, min ?? 0).toISOString());
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateSelect value={date} onChange={(d) => emit(d, time)} future={future} />
      <Select value={time} onValueChange={(t) => emit(date, t)} disabled={!date}>
        <SelectTrigger className="w-24" aria-label="Hora">
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
  );
}
