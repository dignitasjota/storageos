'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { CalendarEventDto, CalendarEventType } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useCalendar } from '@/lib/calendar/hooks';

const TYPE_COLOR: Record<CalendarEventType, string> = {
  task: 'bg-blue-500',
  maintenance: 'bg-violet-500',
  contract_ending: 'bg-amber-500',
  reservation_expiring: 'bg-red-500',
};

const TYPE_LABEL: Record<CalendarEventType, string> = {
  task: 'Tarea',
  maintenance: 'Mantenimiento',
  contract_ending: 'Fin de contrato',
  reservation_expiring: 'Fin de reserva',
};

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Lunes (o el propio día) de la semana de `d`. */
function startOfWeekMonday(d: Date): Date {
  const r = new Date(d);
  const dow = (r.getDay() + 6) % 7; // 0 = lunes
  r.setDate(r.getDate() - dow);
  r.setHours(0, 0, 0, 0);
  return r;
}

export default function CalendarPage() {
  // Mes mostrado (primer día).
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  const firstOfMonth = cursor;
  const gridStart = startOfWeekMonday(firstOfMonth);
  // 6 semanas para cubrir cualquier mes.
  const days = useMemo(
    () => Array.from({ length: 42 }, (_, i) => new Date(gridStart.getTime() + i * 86_400_000)),
    [gridStart],
  );
  const from = ymd(days[0]!);
  const to = ymd(days[41]!);

  const { data } = useCalendar(from, to);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEventDto[]>();
    for (const e of data?.events ?? []) {
      const key = ymd(new Date(e.date));
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [data]);

  const monthLabel = firstOfMonth.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const todayKey = ymd(new Date());

  function shift(delta: number) {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calendario</h1>
          <p className="text-sm text-muted-foreground">
            Tareas, mantenimientos y vencimientos de un vistazo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => shift(-1)} aria-label="Mes anterior">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-40 text-center text-sm font-medium capitalize">{monthLabel}</span>
          <Button variant="outline" size="icon" onClick={() => shift(1)} aria-label="Mes siguiente">
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => shift(0)} className="ml-1">
            Hoy
          </Button>
        </div>
      </div>

      {/* Leyenda */}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(Object.keys(TYPE_LABEL) as CalendarEventType[]).map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-full ${TYPE_COLOR[t]}`} /> {TYPE_LABEL[t]}
          </span>
        ))}
      </div>

      <Card>
        <CardContent className="p-2 sm:p-3">
          <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted-foreground">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const key = ymd(day);
              const inMonth = day.getMonth() === firstOfMonth.getMonth();
              const dayEvents = byDay.get(key) ?? [];
              return (
                <div
                  key={key}
                  className={`min-h-24 rounded-md border p-1 ${inMonth ? '' : 'bg-muted/40'} ${key === todayKey ? 'border-primary' : 'border-border/60'}`}
                >
                  <div
                    className={`px-1 text-xs ${inMonth ? 'text-foreground' : 'text-muted-foreground'} ${key === todayKey ? 'font-semibold text-primary' : ''}`}
                  >
                    {day.getDate()}
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {dayEvents.slice(0, 4).map((e) => (
                      <Link
                        key={`${e.type}-${e.id}`}
                        href={e.href}
                        title={`${TYPE_LABEL[e.type]}: ${e.label}${e.detail ? ` · ${e.detail}` : ''}`}
                        className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] hover:bg-muted"
                      >
                        <span className={`size-1.5 shrink-0 rounded-full ${TYPE_COLOR[e.type]}`} />
                        <span className="truncate">{e.label}</span>
                      </Link>
                    ))}
                    {dayEvents.length > 4 && (
                      <span className="px-1 text-[10px] text-muted-foreground">
                        +{dayEvents.length - 4} más
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
