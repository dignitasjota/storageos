'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { lostUnitIncome, type UpdateUnitInput, UpdateUnitSchema } from '@storageos/shared';
import {
  ArrowLeft,
  Copy,
  Loader2,
  Map as MapIcon,
  Pencil,
  QrCode,
  Trash2,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { UnitDetailsCard } from './unit-details-card';
import { UnitInsightsCard } from './unit-insights-card';
import { UnitPriceCard } from './unit-price-card';
import { UnitReservationCard } from './unit-reservation-card';

import { SectionError } from '@/components/dashboard/section-state';
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ChangeUnitStatusDialog } from '@/components/units/change-status-dialog';
import { CreateUnitDialog } from '@/components/units/create-unit-dialog';
import { useDeleteUnitAction } from '@/components/units/use-delete-unit';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useContracts } from '@/lib/customers/hooks';
import {
  useFloors,
  useUnit,
  useUnitHistory,
  useUnitTypes,
  useUpdateUnit,
} from '@/lib/facilities/hooks';
import { useUnitInsights } from '@/lib/facilities/inventory-hooks';
import { formatDate, formatDateTime, formatEur, formatNumber } from '@/lib/format';

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
  const canDelete = useHasPermission('units:manage');
  const router = useRouter();
  const deleteUnit = useDeleteUnitAction();
  const insights = useUnitInsights(id);
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);

  if (unit.isError) {
    const missing = unit.error instanceof ApiError && unit.error.statusCode === 404;
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/units">
            <ArrowLeft className="mr-1 h-4 w-4" /> Trasteros
          </Link>
        </Button>
        {missing ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Este trastero no existe o ya no está.
          </p>
        ) : (
          <SectionError onRetry={() => void unit.refetch()} />
        )}
      </div>
    );
  }

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
  const stoppedDays = u.outOfServiceSince
    ? Math.floor((Date.now() - new Date(u.outOfServiceSince).getTime()) / 86_400_000)
    : null;
  const partner = insights.data?.stackPartner ?? null;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/units">
            <ArrowLeft className="mr-1 h-4 w-4" /> Trasteros
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{u.code}</h1>
            <StatusBadge status={u.status} />
          </div>
          <div className="flex flex-wrap gap-2">
            {canWrite && !isRented && (
              <Button variant="outline" size="sm" onClick={() => setStatusOpen(true)}>
                Cambiar estado
              </Button>
            )}
            {canWrite && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="mr-1 h-4 w-4" /> Editar trastero
              </Button>
            )}
            {canWrite && (
              <Button variant="outline" size="sm" onClick={() => setDuplicateOpen(true)}>
                <Copy className="mr-1 h-4 w-4" /> Duplicar
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link href={`/units/labels?id=${u.id}`}>
                <QrCode className="mr-1 h-4 w-4" /> Etiqueta
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link
                href={`/units?view=plan&facility=${u.facilityId}&floor=${u.floorId}&unit=${u.id}`}
              >
                <MapIcon className="mr-1 h-4 w-4" /> Ver en el plano
              </Link>
            </Button>
            {canDelete && !isRented && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void deleteUnit(u).then((deleted) => {
                    if (deleted) router.push('/units');
                  })
                }
              >
                <Trash2 className="mr-1 h-4 w-4" /> Borrar
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/facilities/${u.facilityId}`} className="hover:underline">
            {u.facilityName}
          </Link>{' '}
          · {u.floorName} · {u.unitTypeName}
          {partner && (
            <>
              {' · '}apilado con{' '}
              <Link href={`/units/${partner.id}`} className="hover:underline">
                {partner.code}
              </Link>{' '}
              ({STATUS_LABELS[partner.status]})
            </>
          )}
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
            {u.status === 'maintenance' && u.maintenanceUntil && (
              <span className="text-sm text-muted-foreground">
                · vuelve previsto el {formatDate(u.maintenanceUntil)}
              </span>
            )}
          </div>
          {stoppedDays !== null && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {u.outOfServiceReason && <p className="font-medium">{u.outOfServiceReason}</p>}
              <p>
                Parado {stoppedDays} día(s) desde el {formatDate(u.outOfServiceSince)} ·{' '}
                {formatEur(lostUnitIncome(u.basePriceMonthly, stoppedDays))} sin ingresar, al precio
                de catálogo.
              </p>
            </div>
          )}
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
            <p className="text-xl font-semibold">{formatNumber(u.areaM2)} m²</p>
            <p className="text-xs text-muted-foreground">
              {formatNumber(u.widthM)} × {formatNumber(u.depthM)} m
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Volumen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{formatNumber(u.volumeM3)} m³</p>
            <p className="text-xs text-muted-foreground">Alto {formatNumber(u.heightM)} m</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Precio mensual (sin IVA)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold">{formatEur(u.basePriceMonthly)}</p>
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

      <UnitPriceCard unit={u} />
      <UnitInsightsCard unitId={u.id} />
      <UnitDetailsCard unit={u} />

      <Card>
        <CardHeader>
          <CardTitle>Historial de estados</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isLoading && <p className="text-sm text-muted-foreground">Cargando...</p>}
          {history.isError && <SectionError onRetry={() => void history.refetch()} />}
          {history.data && history.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin cambios de estado registrados.</p>
          )}
          {history.data && history.data.length > 0 && (
            <ul className="space-y-2 text-sm">
              {history.data.map((h) => (
                <li key={h.id} className="border-b pb-2 last:border-0">
                  <span className="text-muted-foreground">{formatDateTime(h.occurredAt)}</span> ·{' '}
                  <strong>{STATUS_LABELS[h.previousStatus]}</strong> →{' '}
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

      <EditUnitDialog unit={u} rented={isRented} open={editOpen} onOpenChange={setEditOpen} />
      <ChangeUnitStatusDialog unit={statusOpen ? u : null} onClose={() => setStatusOpen(false)} />
      {duplicateOpen && (
        <CreateUnitDialog
          open
          copyFrom={u}
          onOpenChange={setDuplicateOpen}
          onCreated={(created) => router.push(`/units/${created.id}`)}
        />
      )}
    </div>
  );
}

function EditUnitDialog({
  unit,
  rented,
  open,
  onOpenChange,
}: {
  rented: boolean;
  unit: {
    id: string;
    code: string;
    facilityId: string;
    floorId: string;
    unitTypeId: string;
    stackGroupId: string | null;
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
  const types = useUnitTypes();
  const activeTypes = (types.data ?? []).filter((t) => t.isActive || t.id === unit.unitTypeId);
  const floors = useFloors(open ? unit.facilityId : undefined);
  const floorList = floors.data ?? [];
  const form = useForm<UpdateUnitInput>({
    resolver: zodResolver(UpdateUnitSchema),
    values: {
      code: unit.code,
      floorId: unit.floorId,
      unitTypeId: unit.unitTypeId,
      widthM: unit.widthM,
      depthM: unit.depthM,
      heightM: unit.heightM,
      basePriceMonthly: unit.basePriceMonthly,
      notes: unit.notes ?? '',
    },
  });

  const [width = 0, depth = 0, height = 0] = form.watch(['widthM', 'depthM', 'heightM']);

  async function onSubmit(values: UpdateUnitInput) {
    try {
      await update.mutateAsync({ id: unit.id, input: values });
      toast.success('Trastero actualizado.');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && (err.body as { code?: string }).code === 'unit_code_taken') {
        form.setError('code', { message: 'Ya existe un trastero con ese código en este local.' });
        return;
      }
      if (
        err instanceof ApiError &&
        (err.body as { code?: string }).code === 'cannot_change_kind_while_rented'
      ) {
        toast.error(
          'Tiene un contrato en vigor: no puede pasar de trastero a vivienda ni al revés.',
        );
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo actualizar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar trastero</DialogTitle>
        </DialogHeader>
        {rented && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Está alquilado: el precio que cambies aquí vale para el próximo contrato; la cuota del
            inquilino actual no cambia (para subirla, usa Subidas de precio o «Cambiar precio» en su
            contrato).
          </p>
        )}
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Código</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {floorList.length > 1 && (
              <FormField
                control={form.control}
                name="floorId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Planta</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={!!unit.stackGroupId}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {floorList.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="unitTypeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tipo de trastero</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!!unit.stackGroupId}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecciona un tipo" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {activeTypes.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {unit.stackGroupId && (
                    <FormDescription>
                      Este trastero está apilado con otro — desapílalo desde el plano para poder
                      cambiar su tipo o su planta.
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
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
            <p className="text-sm">
              Superficie:{' '}
              <span className="font-semibold">
                {Number.isFinite(width * depth) && width > 0 && depth > 0
                  ? `${formatNumber(width * depth)} m²`
                  : '—'}
              </span>
              {Number.isFinite(width * depth * height) && width > 0 && depth > 0 && height > 0 && (
                <span className="text-muted-foreground">
                  {' '}
                  · Volumen {formatNumber(width * depth * height)} m³
                </span>
              )}
            </p>
            <FormField
              control={form.control}
              name="basePriceMonthly"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Precio mensual sin IVA (€)</FormLabel>
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
