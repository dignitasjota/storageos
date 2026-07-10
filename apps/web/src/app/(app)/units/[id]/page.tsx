'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type UpdateUnitInput, UpdateUnitSchema } from '@storageos/shared';
import { ArrowLeft, Loader2, Pencil, User } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { UnitReservationCard } from './unit-reservation-card';

import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useContracts } from '@/lib/customers/hooks';
import { useUnit, useUnitHistory, useUpdateUnit } from '@/lib/facilities/hooks';

const STATUS_LABELS: Record<string, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

export default function UnitDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const unit = useUnit(id);
  const history = useUnitHistory(id);
  // Contrato vigente del trastero (para mostrar el inquilino que lo ocupa).
  const contracts = useContracts(id ? { unitId: id } : {});
  const canWrite = useHasPermission('units:write');
  const [editOpen, setEditOpen] = useState(false);

  if (unit.isLoading || !unit.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const u = unit.data;
  const activeContract = (contracts.data ?? []).find(
    (c) => c.status === 'active' || c.status === 'ending',
  );
  const isRented = u.status === 'occupied' || !!activeContract;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/units">
            <ArrowLeft className="mr-1 h-4 w-4" /> Trasteros
          </Link>
        </Button>
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{u.code}</h1>
            <StatusBadge status={u.status} />
          </div>
          {canWrite && !isRented && (
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1 h-4 w-4" /> Editar trastero
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/facilities/${u.facilityId}`} className="hover:underline">
            {u.facilityName}
          </Link>{' '}
          · {u.floorName} · {u.unitTypeName}
        </p>
      </div>

      {/* Estado actual */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Estado actual</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={u.status} />
            <span className="text-sm text-muted-foreground">{STATUS_LABELS[u.status]}</span>
          </div>
          {activeContract ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                <User className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Inquilino actual</p>
                <Link
                  href={`/customers/${activeContract.customerId}`}
                  className="font-medium hover:underline"
                >
                  {activeContract.customerName}
                </Link>
              </div>
              <Button asChild variant="outline" size="sm" className="ml-auto">
                <Link href={`/contracts/${activeContract.id}`}>Ver contrato</Link>
              </Button>
            </div>
          ) : u.status === 'available' ? (
            <p className="text-sm text-muted-foreground">
              Disponible para alquilar — sin contrato activo.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Sin inquilino asignado actualmente.</p>
          )}
        </CardContent>
      </Card>

      {/* Reserva manual para un cliente (solo si no está ocupado). */}
      {!activeContract && <UnitReservationCard unitId={u.id} unitStatus={u.status} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Área</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{u.areaM2.toFixed(2)} m²</p>
            <p className="text-xs text-muted-foreground">
              {u.widthM} × {u.depthM} m
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Volumen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{u.volumeM3.toFixed(2)} m³</p>
            <p className="text-xs text-muted-foreground">Alto {u.heightM} m</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Precio mensual
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{u.basePriceMonthly.toFixed(2)} €</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Notas</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{u.notes ?? '—'}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Historial de estados</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isLoading && <p className="text-sm text-muted-foreground">Cargando...</p>}
          {history.data && history.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin cambios de estado registrados.</p>
          )}
          {history.data && history.data.length > 0 && (
            <ul className="space-y-2 text-sm">
              {history.data.map((h) => (
                <li key={h.id} className="border-b pb-2 last:border-0">
                  <span className="text-muted-foreground">
                    {new Date(h.occurredAt).toLocaleString('es-ES')}
                  </span>{' '}
                  · <strong>{STATUS_LABELS[h.previousStatus]}</strong> →{' '}
                  <strong>{STATUS_LABELS[h.newStatus]}</strong>
                  {h.changedByName && ` · ${h.changedByName}`}
                  {h.reason && (
                    <span className="block pl-1 text-muted-foreground">
                      &ldquo;{h.reason}&rdquo;
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <EditUnitDialog unit={u} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}

function EditUnitDialog({
  unit,
  open,
  onOpenChange,
}: {
  unit: {
    id: string;
    widthM: number;
    depthM: number;
    heightM: number;
    basePriceMonthly: number;
    notes: string | null;
  };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const update = useUpdateUnit();
  const form = useForm<UpdateUnitInput>({
    resolver: zodResolver(UpdateUnitSchema),
    values: {
      widthM: unit.widthM,
      depthM: unit.depthM,
      heightM: unit.heightM,
      basePriceMonthly: unit.basePriceMonthly,
      notes: unit.notes ?? '',
    },
  });

  async function onSubmit(values: UpdateUnitInput) {
    try {
      await update.mutateAsync({ id: unit.id, input: values });
      toast.success('Trastero actualizado.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo actualizar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar trastero</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="widthM"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ancho (m)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.valueAsNumber)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="depthM"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fondo (m)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.valueAsNumber)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="heightM"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Alto (m)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        {...field}
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.valueAsNumber)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              El área (m²) y el volumen (m³) se recalculan automáticamente.
            </p>
            <FormField
              control={form.control}
              name="basePriceMonthly"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Precio mensual (€)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.valueAsNumber)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notas</FormLabel>
                  <FormControl>
                    <Textarea {...field} value={field.value ?? ''} rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? 'Guardando…' : 'Guardar'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
