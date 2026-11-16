'use client';

import {
  type MarketingAnnotationDto,
  type WebAnalyticsDto,
  type WebBookingFunnelDto,
  type WebContactHourDto,
  type WebDemandDto,
} from '@storageos/shared';
import { Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDate } from '@/lib/format';
import { useMarketingAnnotation } from '@/lib/marketing/hooks';
import { isStaffBrowser, setStaffBrowser } from '@/lib/tenant-consent';

const int = (n: number) => n.toLocaleString('es-ES');
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)} %` : '—');

/** Dónde se queda la gente de camino a la reserva pagada. */
export function BookingFunnelCard({ funnel }: { funnel: WebBookingFunnelDto }) {
  const steps = [
    { label: 'Visitantes de la web', value: funnel.visitors },
    { label: 'Abrieron la reserva', value: funnel.bookingPage },
    { label: 'Eligieron tamaño', value: funnel.started },
    { label: 'Reservaron', value: funnel.bookings },
    { label: 'Firmaron', value: funnel.signed },
    { label: 'Pagaron', value: funnel.paid },
  ];
  const top = Math.max(1, funnel.visitors);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Embudo de la reserva online</CardTitle>
        <CardDescription>
          Cuántos llegan a cada paso y cuántos se quedan por el camino.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2 text-sm">
          {steps.map((s, i) => {
            const prev = i > 0 ? steps[i - 1]!.value : null;
            return (
              <li key={s.label} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span>{s.label}</span>
                  <span className="tabular-nums">
                    <span className="font-medium">{int(s.value)}</span>
                    {prev !== null && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {pct(s.value, prev)} del paso anterior
                      </span>
                    )}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-primary"
                    style={{ width: `${Math.max(2, (s.value / top) * 100)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
/** El domingo es el 0 en los datos; aquí la semana empieza el lunes. */
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOURS = Array.from({ length: 17 }, (_, i) => i + 7);

/** Clics en llamar y WhatsApp por día y hora: cuándo conviene tener el teléfono a mano. */
export function ContactHoursCard({ hours }: { hours: WebContactHourDto[] }) {
  const cell = new Map(hours.map((h) => [`${h.weekday}-${h.hour}`, h.calls + h.whatsapp]));
  const max = Math.max(0, ...cell.values());
  const outside = hours.filter((h) => h.hour < 7).reduce((n, h) => n + h.calls + h.whatsapp, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cuándo te llaman y escriben</CardTitle>
        <CardDescription>
          Clics en llamar y WhatsApp de la web por día y hora (de 7 a 23 h).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {max === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Aún no hay clics en llamar ni en WhatsApp en este periodo.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-0.5 text-[10px]">
              <thead>
                <tr>
                  <th className="sr-only">Día</th>
                  {HOURS.map((h) => (
                    <th key={h} className="w-6 font-normal text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ORDER.map((wd, i) => (
                  <tr key={wd}>
                    <th className="pr-2 text-left font-normal text-muted-foreground">
                      {WEEKDAYS[i]!.slice(0, 3)}
                    </th>
                    {HOURS.map((h) => {
                      const n = cell.get(`${wd}-${h}`) ?? 0;
                      const alpha = n > 0 ? 0.15 + (n / max) * 0.85 : 0;
                      return (
                        <td
                          key={h}
                          className="h-6 w-6 rounded-sm border text-center"
                          style={{
                            backgroundColor: n > 0 ? `rgba(37, 99, 235, ${alpha})` : undefined,
                          }}
                          title={`${WEEKDAYS[i]} a las ${h}:00: ${n} ${n === 1 ? 'clic' : 'clics'}`}
                        >
                          <span className="sr-only">{n}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {outside > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Y {int(outside)} de madrugada (antes de las 7).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Qué locales y tamaños miran y empiezan a reservar. */
export function DemandCard({ demand }: { demand: WebDemandDto[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Qué buscan</CardTitle>
        <CardDescription>
          Visitas a la ficha de cada local y reservas empezadas por tamaño.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {demand.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Aún no hay visitas a los locales ni reservas empezadas en este periodo.
          </p>
        ) : (
          <ul className="space-y-3 text-sm">
            {demand.map((d) => (
              <li key={d.facilityId}>
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{d.facilityName}</span>
                  <span className="text-xs text-muted-foreground">
                    {int(d.pageViews)} {d.pageViews === 1 ? 'visita' : 'visitas'} ·{' '}
                    {int(d.bookingStarts)}{' '}
                    {d.bookingStarts === 1 ? 'reserva empezada' : 'reservas empezadas'}
                  </span>
                </div>
                {d.sizes.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {d.sizes.map((s) => `${s.name}: ${int(s.bookingStarts)}`).join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Notas en la gráfica: las escritas por el equipo y lo que pasó esos días. */
export function AnnotationsCard({ annotations }: { annotations: MarketingAnnotationDto[] }) {
  const canManage = useHasPermission('marketing:manage');
  const mutate = useMarketingAnnotation();
  const [day, setDay] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');

  async function add() {
    if (!day || !text.trim()) {
      toast.error('Elige el día y escribe la nota.');
      return;
    }
    try {
      await mutate.mutateAsync({ kind: 'add', day, text: text.trim() });
      setText('');
      toast.success('Nota añadida.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function remove(id: string) {
    try {
      await mutate.mutateAsync({ kind: 'delete', id });
    } catch {
      toast.error('No se pudo borrar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lo que pasó estos días</CardTitle>
        <CardDescription>
          Ayuda a entender los picos de la gráfica: canales nuevos, promociones, campañas y
          publicaciones, y tus notas (un cartel nuevo, un anuncio en la radio…).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {annotations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada anotado en este periodo.</p>
        ) : (
          <ul className="divide-y text-sm">
            {annotations.map((a, i) => (
              <li key={a.id ?? `${a.day}-${i}`} className="flex items-center gap-2 py-1.5">
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {formatDate(a.day)}
                </span>
                <span className="flex-1">{a.text}</span>
                {a.id && canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-red-600"
                    aria-label="Borrar la nota"
                    onClick={() => remove(a.id!)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="flex flex-wrap items-end gap-2 border-t pt-3">
            <div className="space-y-1">
              <Label className="text-xs">Día</Label>
              <DateSelect value={day} onChange={setDay} years={2} />
            </div>
            <div className="min-w-[12rem] flex-1 space-y-1">
              <Label htmlFor="annotation-text" className="text-xs">
                Nota
              </Label>
              <Input
                id="annotation-text"
                maxLength={120}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Ej.: buzoneo en el barrio"
              />
            </div>
            <Button onClick={add} disabled={mutate.isPending} className="h-9">
              {mutate.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              Añadir nota
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Las visitas del propio equipo no cuentan: cómo funciona y cómo cambiarlo. */
export function StaffVisitsNote() {
  const [staff, setStaff] = useState<boolean | null>(null);
  useEffect(() => setStaff(isStaffBrowser()), []);
  if (staff === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {staff
        ? 'Tus visitas desde este navegador no cuentan (eres del equipo). '
        : 'Tus visitas desde este navegador cuentan como las de cualquier visitante. '}
      <button
        type="button"
        className="text-primary underline-offset-2 hover:underline"
        onClick={() => {
          setStaffBrowser(!staff);
          setStaff(!staff);
        }}
      >
        {staff ? 'Contarlas' : 'No contarlas'}
      </button>
      . En tu dominio propio, abre tu web una vez con <code>?no_track=1</code> al final de la
      dirección desde cada móvil u ordenador del equipo.
    </p>
  );
}

/** Nuevos y que vuelven. */
export function visitorsSplit(data: WebAnalyticsDto): string {
  return `${int(data.newVisitors)} ${data.newVisitors === 1 ? 'nuevo' : 'nuevos'} · ${int(
    data.returningVisitors,
  )} ${data.returningVisitors === 1 ? 'vuelve' : 'vuelven'}`;
}
