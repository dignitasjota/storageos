'use client';

import { CalendarClock, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  useCancelReservation,
  useCreateReservation,
  useCustomers,
  useReservations,
} from '@/lib/customers/hooks';

/** Fecha (YYYY-MM-DD) → ISO al final de ese día, para que la reserva cubra el día completo. */
function endOfDayIso(date: string): string {
  return new Date(`${date}T23:59:59`).toISOString();
}

/**
 * Reserva manual del trastero para un cliente concreto con fecha de caducidad.
 * El trastero pasa a `reserved`; un cron lo libera solo al pasar la fecha si no
 * se ha convertido en contrato. Solo se muestra en trasteros disponibles o
 * reservados manualmente (no en ocupados/mantenimiento/bloqueados).
 */
export function UnitReservationCard({
  unitId,
  unitStatus,
}: {
  unitId: string;
  unitStatus: string;
}) {
  const canManage = useHasPermission('reservations:write');
  const reservations = useReservations({ unitId });
  const create = useCreateReservation();
  const cancel = useCancelReservation();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [until, setUntil] = useState('');
  const [notes, setNotes] = useState('');
  const customers = useCustomers(search);

  if (unitStatus !== 'available' && unitStatus !== 'reserved') return null;

  const active = (reservations.data ?? []).find(
    (r) => r.status === 'pending' || r.status === 'confirmed',
  );

  async function onReserve() {
    if (!customerId) {
      toast.error('Elige un cliente.');
      return;
    }
    if (!until) {
      toast.error('Indica hasta qué día se reserva.');
      return;
    }
    try {
      await create.mutateAsync({
        unitId,
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: endOfDayIso(until),
        depositAmount: 0,
        notes: notes.trim() || undefined,
        confirmImmediately: true,
      });
      toast.success('Trastero reservado para el cliente.');
      setOpen(false);
      setCustomerId('');
      setUntil('');
      setNotes('');
      setSearch('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reservar.');
    }
  }

  async function onRelease() {
    if (!active) return;
    try {
      await cancel.mutateAsync({ id: active.id, input: { reason: 'Liberada manualmente' } });
      toast.success('Reserva liberada; el trastero vuelve a estar disponible.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo liberar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4 text-muted-foreground" />
          Reserva para un cliente
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {active ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 p-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Reservado para</p>
              {active.customerId ? (
                <Link
                  href={`/customers/${active.customerId}`}
                  className="font-medium hover:underline"
                >
                  {active.customerName ?? 'Cliente'}
                </Link>
              ) : (
                <span className="font-medium">{active.customerName ?? 'Sin cliente'}</span>
              )}
              <p className="text-xs text-muted-foreground">
                Hasta {new Date(active.validUntil).toLocaleDateString('es-ES')}
                {active.notes ? ` · ${active.notes}` : ''}
              </p>
            </div>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={onRelease}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Liberar'}
              </Button>
            )}
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Retén este trastero para un cliente hasta una fecha. Si no se firma el contrato, se
              libera automáticamente.
            </p>
            {canManage && (
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Reservar para un cliente
              </Button>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reservar para un cliente</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Cliente</Label>
              <Input
                placeholder="Buscar por nombre o email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige un cliente" />
                </SelectTrigger>
                <SelectContent>
                  {(customers.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName}
                      {c.email ? ` · ${c.email}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Reservar hasta</Label>
              <Input
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Notas (opcional)</Label>
              <Textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Motivo, contacto…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={onReserve} disabled={create.isPending}>
              {create.isPending ? 'Reservando…' : 'Reservar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
