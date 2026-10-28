'use client';

import { DEFAULT_PRE_OPENING_MAX_MONTHS, type FacilityDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useFacilityOpening, useUpdateFacilityOpening } from '@/lib/facilities/hooks';
import { formatDate } from '@/lib/format';

/** Local que aún no ha abierto: se alquila por adelantado («reservas antes de la apertura»). */
export function PreOpeningCard({ facility }: { facility: FacilityDto }) {
  const opening = useFacilityOpening(facility.id);
  const update = useUpdateFacilityOpening(facility.id);
  const confirm = useConfirm();
  const [preOpening, setPreOpening] = useState(false);
  const [hasDate, setHasDate] = useState(false);
  const [date, setDate] = useState<string | undefined>(undefined);
  const [maxMonths, setMaxMonths] = useState(String(DEFAULT_PRE_OPENING_MAX_MONTHS));

  useEffect(() => {
    if (!opening.data) return;
    setPreOpening(opening.data.preOpening);
    setHasDate(!!opening.data.openingDate);
    setDate(opening.data.openingDate ?? undefined);
    setMaxMonths(String(opening.data.maxMonths));
  }, [opening.data]);

  if (!opening.data) {
    return (
      <Card>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  const current = opening.data;
  const months = Number(maxMonths);
  const nextDate = preOpening && hasDate ? (date ?? null) : null;
  const dirty =
    preOpening !== current.preOpening ||
    nextDate !== current.openingDate ||
    months !== current.maxMonths;
  const valid = Number.isInteger(months) && months >= 1 && months <= 36 && (!hasDate || !!date);

  async function save() {
    const reservations = current.reservations;
    if (reservations > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const opensNow = !preOpening || (nextDate !== null && nextDate <= today);
      if (opensNow) {
        const ok = await confirm({
          title: 'Abrir el local ahora',
          description: `Las ${reservations} reservas empiezan hoy: el trastero pasa a ocupado, cada inquilino que ya pagó recibe su código de acceso y la facturación mensual sigue el mes que viene.`,
          confirmLabel: 'Abrir ahora',
        });
        if (!ok) return;
      } else if (nextDate !== current.openingDate) {
        const ok = await confirm({
          title: 'Cambiar la fecha de apertura',
          description: `Se avisará por correo a ${reservations} ${reservations === 1 ? 'inquilino' : 'inquilinos'} con reserva y su fecha de inicio pasará a ${nextDate ? formatDate(nextDate) : '«por confirmar»'}.`,
          confirmLabel: 'Cambiar y avisar',
        });
        if (!ok) return;
      }
    }
    try {
      const res = await update.mutateAsync({
        preOpening,
        openingDate: nextDate,
        maxMonths: months,
      });
      toast.success(
        res.started > 0
          ? `Local abierto: ${res.started} ${res.started === 1 ? 'reserva empieza' : 'reservas empiezan'} hoy.`
          : res.moved > 0
            ? `Fecha guardada. Avisados ${res.moved} ${res.moved === 1 ? 'inquilino' : 'inquilinos'}.`
            : 'Guardado.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Próxima apertura</CardTitle>
        <CardDescription>
          Si el local aún no ha abierto, tus clientes pueden reservar ya su trastero: pagan la
          primera mensualidad y la fianza, y el alquiler empieza el día que abras. La fecha es
          opcional y la puedes cambiar; a los inquilinos se les avisa por correo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={preOpening} onCheckedChange={(v) => setPreOpening(v === true)} />
          El local aún no ha abierto (admite reservas antes de la apertura)
        </label>
        {preOpening && (
          <div className="space-y-4 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={hasDate} onCheckedChange={(v) => setHasDate(v === true)} />
              Ya sé la fecha de apertura
            </label>
            {hasDate && (
              <div className="space-y-1">
                <Label>Fecha de apertura prevista</Label>
                <DateSelect value={date} onChange={setDate} future years={3} />
              </div>
            )}
            <div className="max-w-xs space-y-1">
              <Label htmlFor="po-max">Plazo máximo para abrir (meses desde la reserva)</Label>
              <Input
                id="po-max"
                type="number"
                min={1}
                max={36}
                value={maxMonths}
                onChange={(e) => setMaxMonths(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Si el local no ha abierto en ese plazo, el cliente puede cancelar y recuperar todo
                lo pagado.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Al llegar la fecha (o al quitar «aún no ha abierto») las reservas empiezan: el
              trastero pasa a ocupado y cada inquilino recibe su código de acceso. Dentro de los 14
              días siguientes a la reserva el cliente puede desistir con devolución íntegra; después
              se le devuelve la mensualidad y se queda la fianza.
            </p>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {current.reservations > 0
              ? `${current.reservations} ${current.reservations === 1 ? 'reserva' : 'reservas'} esperando la apertura.`
              : 'Ninguna reserva esperando la apertura.'}
          </p>
          <Button onClick={() => void save()} disabled={!dirty || !valid || update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
