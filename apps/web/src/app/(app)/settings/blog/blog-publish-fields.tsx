'use client';

import { DateSelect } from '@/components/month-year-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatZonedDateTime } from '@/lib/promo-landings/dates';

/** Borrador, publicada ya o programada para una fecha y hora. */
export type BlogPublishMode = 'draft' | 'now' | 'schedule';

/** Horas cada media hora para programar. */
const HOURS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, '0');
  return `${h}:${i % 2 === 0 ? '00' : '30'}`;
});

const MODES: { value: BlogPublishMode; label: string; hint: string }[] = [
  { value: 'draft', label: 'Borrador', hint: 'No sale en la web.' },
  { value: 'now', label: 'Publicar ahora', hint: 'Sale en la web al guardar.' },
  { value: 'schedule', label: 'Programar', hint: 'Se publica sola el día y la hora que elijas.' },
];

/** Elección de cuándo sale la entrada en la web (fecha y hora en la zona del negocio). */
export function BlogPublishFields({
  mode,
  onMode,
  date,
  time,
  onDate,
  onTime,
  timeZone,
  scheduledIso,
}: {
  mode: BlogPublishMode;
  onMode: (m: BlogPublishMode) => void;
  date: string;
  time: string;
  onDate: (d: string) => void;
  onTime: (t: string) => void;
  timeZone: string;
  /** El instante elegido (null si falta el día o no es válido). */
  scheduledIso: string | null;
}) {
  const past = mode === 'schedule' && scheduledIso && new Date(scheduledIso) <= new Date();
  return (
    <fieldset className="space-y-2 rounded-md border border-dashed p-3">
      <legend className="px-1 text-sm font-medium">Publicación</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Publicación">
        {MODES.map((m) => (
          <label
            key={m.value}
            className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              mode === m.value ? 'border-primary bg-primary/5' : ''
            }`}
          >
            <input
              type="radio"
              name="blog-publish-mode"
              className="accent-primary"
              checked={mode === m.value}
              onChange={() => onMode(m.value)}
            />
            {m.label}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{MODES.find((m) => m.value === mode)?.hint}</p>
      {mode === 'schedule' && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <DateSelect value={date || undefined} onChange={(d) => onDate(d ?? '')} future />
            <Select value={time} onValueChange={onTime} disabled={!date}>
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
          <p className="text-xs text-muted-foreground">
            En la hora de tu negocio ({timeZone}).
            {scheduledIso && !past
              ? ` Se publicará el ${formatZonedDateTime(scheduledIso, timeZone)}.`
              : ''}
          </p>
          {!date && <p className="text-xs text-destructive">Elige el día.</p>}
          {past && (
            <p className="text-xs text-destructive">
              Esa fecha ya ha pasado: elige una futura o publica ahora.
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
