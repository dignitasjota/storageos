'use client';

import {
  ReservationStatusEnum,
  UNIT_HOLD_LABELS,
  type HeldUnitDto,
  type ReservationDto,
  type ReservationSignalPolicy,
  type ReservationStatusValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Download, MoreHorizontal, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { DateSelect } from '@/components/month-year-select';
import { ReservationStatusBadge } from '@/components/reservation-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import {
  useCancelReservation,
  useConfirmReservation,
  useCreateReservation,
  useReservations,
} from '@/lib/customers/hooks';
import { useFacilities, useUnits } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
import { formatDate, formatEur, formatNumber } from '@/lib/format';
import { useReservationDepositInvoice } from '@/lib/operations/features-hooks';
import {
  useHeldUnits,
  useReservationSettings,
  useReservationStats,
  useUpdateReservation,
  useUpdateReservationSettings,
} from '@/lib/unit-ops/hooks';

const STATUS_LABELS: Record<ReservationStatusValue, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  expired: 'Caducada',
  converted: 'Convertida',
  cancelled: 'Cancelada',
};

/** Sin filtro se ven las vivas; `all` enseña también las cerradas. */
type StatusFilter = ReservationStatusValue | 'live' | 'all';

export default function ReservationsPage() {
  const [status, setStatus] = useState<StatusFilter>('live');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Enlaces con filtro (`/reservations?status=pending` desde «Hoy»).
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const parsed = ReservationStatusEnum.safeParse(query.get('status'));
    if (parsed.success) setStatus(parsed.data);
    if (query.get('settings')) setSettingsOpen(true);
  }, []);
  const [facilityId, setFacilityId] = useFacilityFilterState();

  const facilities = useFacilities();
  const reservations = useReservations({
    ...(status !== 'live' && status !== 'all' ? { status } : {}),
    ...(facilityId ? { facilityId } : {}),
  });
  const rows = (reservations.data ?? []).filter(
    (r) => status !== 'live' || r.status === 'pending' || r.status === 'confirmed',
  );

  const confirm = useConfirmReservation();
  const depositInvoice = useReservationDepositInvoice();
  const canInvoice = useHasPermission('invoices:manage');
  const cancel = useCancelReservation();
  const router = useRouter();
  const canWrite = useHasPermission('reservations:write');
  const canContract = useHasPermission('contracts:write');

  const [creating, setCreating] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ReservationDto | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [keepSignal, setKeepSignal] = useState<boolean | undefined>();
  const [editing, setEditing] = useState<ReservationDto | null>(null);
  const settings = useReservationSettings();
  const canManageSettings = useHasPermission('settings:manage');

  function exportCsv() {
    downloadCsv('reservas.csv', [
      [
        'Local',
        'Trastero',
        'Inquilino',
        'Estado',
        'Desde',
        'Hasta',
        'Señal',
        'Señal cobrada',
        'Notas',
      ],
      ...rows.map((r) => [
        r.facilityName,
        r.unitCode,
        r.customerName ?? '',
        STATUS_LABELS[r.status],
        formatDate(r.validFrom),
        formatDate(r.validUntil),
        r.depositAmount,
        r.depositPaid ? 'Sí' : 'No',
        r.cancelReason ?? r.notes ?? '',
      ]),
    ]);
  }

  const columns: ColumnDef<ReservationDto>[] = [
    {
      id: 'unit',
      header: 'Trastero',
      cell: ({ row }) => (
        <span className="text-sm">
          <Link href={`/facilities/${row.original.facilityId}`} className="hover:underline">
            {row.original.facilityName}
          </Link>{' '}
          ·{' '}
          <Link href={`/units/${row.original.unitId}`} className="hover:underline">
            {row.original.unitCode}
          </Link>
        </span>
      ),
    },
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) =>
        row.original.customerId ? (
          <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
            {row.original.customerName}
          </Link>
        ) : (
          (row.original.customerName ?? '—')
        ),
    },
    {
      id: 'notes',
      header: 'Notas',
      cell: ({ row }) => {
        const text = row.original.cancelReason ?? row.original.notes;
        return text ? (
          <span className="line-clamp-2 max-w-xs text-xs text-muted-foreground">{text}</span>
        ) : null;
      },
    },
    {
      accessorKey: 'validFrom',
      header: 'Desde',
      cell: ({ row }) => formatDate(row.original.validFrom),
    },
    {
      accessorKey: 'validUntil',
      header: 'Hasta',
      cell: ({ row }) => formatDate(row.original.validUntil),
    },
    {
      accessorKey: 'depositAmount',
      header: 'Señal',
      cell: ({ row }) => {
        const r = row.original;
        if (r.depositAmount <= 0) return <span className="text-muted-foreground">—</span>;
        return (
          <span className="text-sm">
            {formatEur(r.depositAmount)}{' '}
            {r.depositPaid ? (
              <span className="text-xs text-emerald-600">cobrada</span>
            ) : r.depositInvoiceId ? (
              <Link href={`/invoices/${r.depositInvoiceId}`} className="text-xs underline">
                por cobrar
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">sin factura</span>
            )}
          </span>
        );
      },
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <ReservationStatusBadge status={row.original.status} />,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const r = row.original;
        if (!canWrite) return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Acciones">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {r.status === 'pending' && (
                <DropdownMenuItem
                  onClick={() =>
                    confirm.mutateAsync(r.id).then(
                      () => toast.success('Reserva confirmada.'),
                      (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                    )
                  }
                >
                  Confirmar
                </DropdownMenuItem>
              )}
              {(r.status === 'pending' || r.status === 'confirmed') &&
                r.depositAmount > 0 &&
                !r.depositInvoiceId &&
                r.customerId &&
                canInvoice && (
                  <DropdownMenuItem
                    onClick={() =>
                      depositInvoice.mutateAsync(r.id).then(
                        () => toast.success('Factura de la señal emitida.'),
                        (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                      )
                    }
                  >
                    Facturar la señal
                  </DropdownMenuItem>
                )}
              {(r.status === 'pending' || r.status === 'confirmed') && (
                <DropdownMenuItem onClick={() => setEditing(r)}>
                  Editar o prorrogar
                </DropdownMenuItem>
              )}
              {(r.status === 'pending' || r.status === 'confirmed') && canContract && (
                <DropdownMenuItem
                  onClick={() => router.push(`/contracts/new?reservationId=${r.id}`)}
                >
                  Convertir en contrato
                </DropdownMenuItem>
              )}
              {(r.status === 'pending' || r.status === 'confirmed') && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => {
                    setCancelTarget(r);
                    setCancelReason('');
                    setKeepSignal(undefined);
                  }}
                >
                  Cancelar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reservas</h1>
          <p className="text-sm text-muted-foreground">
            Pre-bloqueos de trastero antes de la firma del contrato.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageSettings && (
            <Button variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-1 size-4" /> Ajustes
            </Button>
          )}
          {canWrite && <Button onClick={() => setCreating(true)}>Nueva reserva</Button>}
        </div>
      </div>

      <StatsStrip />

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Reservas</TabsTrigger>
          <TabsTrigger value="held">Trasteros guardados</TabsTrigger>
        </TabsList>
        <TabsContent value="held" className="mt-4">
          <HeldUnitsTab />
        </TabsContent>
        <TabsContent value="list" className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="live">Vivas</SelectItem>
                <SelectItem value="all">Todos los estados</SelectItem>
                {(Object.keys(STATUS_LABELS) as ReservationStatusValue[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={facilityId ?? 'all'}
              onValueChange={(v) => setFacilityId(v === 'all' ? undefined : v)}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Local" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los locales</SelectItem>
                {(facilities.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="mr-1 size-4" /> CSV
            </Button>
          </div>

          {reservations.isError ? (
            <SectionError onRetry={() => void reservations.refetch()} />
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              isLoading={reservations.isLoading}
              guide="alquilar"
              emptyText={
                status === 'live'
                  ? 'No hay reservas vivas. Crea una aquí o desde la ficha de un trastero libre.'
                  : 'No hay reservas con este filtro.'
              }
            />
          )}
        </TabsContent>
      </Tabs>

      {creating && (
        <NewReservationDialog facilityId={facilityId} onClose={() => setCreating(false)} />
      )}
      {editing && <EditReservationDialog reservation={editing} onClose={() => setEditing(null)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      <Dialog open={!!cancelTarget} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar la reserva</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {cancelTarget?.customerName ?? 'Sin inquilino'} · {cancelTarget?.unitCode}. Si el
            trastero estaba retenido para esta reserva, vuelve a estar disponible.
          </p>
          <div>
            <Label htmlFor="cancel-reason">Motivo</Label>
            <Input
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Ej.: ya no lo necesita"
            />
          </div>
          {cancelTarget?.depositPaid && (
            <div>
              <Label>La señal está cobrada</Label>
              <Select
                value={(keepSignal ?? settings.data?.signalPolicy === 'keep') ? 'keep' : 'refund'}
                onValueChange={(v) => setKeepSignal(v === 'keep')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="refund">Devolverla (deja un abono en borrador)</SelectItem>
                  <SelectItem value="keep">Se la queda el negocio</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              Volver
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() =>
                cancelTarget &&
                cancel
                  .mutateAsync({
                    id: cancelTarget.id,
                    input: {
                      reason: cancelReason.trim() || 'Cancelada por el equipo',
                      ...(keepSignal !== undefined ? { keepSignal } : {}),
                    },
                  })
                  .then(
                    () => {
                      toast.success('Reserva cancelada.');
                      setCancelTarget(null);
                    },
                    (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
                  )
              }
            >
              Cancelar la reserva
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Cómo van las reservas y lo que tarda el equipo en responder. */
function StatsStrip() {
  const stats = useReservationStats(90);
  if (!stats.data) return null;
  const s = stats.data;
  const cells: [string, string][] = [
    ['Reservas (90 días)', String(s.created)],
    ['Acaban en contrato', s.conversionPct === null ? '—' : `${s.conversionPct} %`],
    ['Caducadas', String(s.expired)],
    ['Señales cobradas', String(s.signalsPaid)],
    [
      'Responder a una petición',
      s.requestResponseHours === null ? '—' : `${formatNumber(s.requestResponseHours)} h`,
    ],
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {cells.map(([label, value]) => (
        <Card key={label}>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Todos los trasteros reservados, sea cual sea el motivo. */
function HeldUnitsTab() {
  const held = useHeldUnits();
  const columns: ColumnDef<HeldUnitDto>[] = [
    {
      id: 'unit',
      header: 'Trastero',
      cell: ({ row }) => (
        <span className="text-sm">
          {row.original.facilityName} ·{' '}
          <Link href={`/units/${row.original.unitId}`} className="hover:underline">
            {row.original.unitCode}
          </Link>
          {row.original.unitTypeName ? ` · ${row.original.unitTypeName}` : ''}
        </span>
      ),
    },
    {
      id: 'reason',
      header: 'Motivo',
      cell: ({ row }) =>
        row.original.hold ? (
          <Link href={row.original.hold.link} className="hover:underline">
            {UNIT_HOLD_LABELS[row.original.hold.kind]}
          </Link>
        ) : (
          <span className="text-amber-600">Nadie lo retiene</span>
        ),
    },
    {
      id: 'who',
      header: 'Para quién',
      cell: ({ row }) => {
        const h = row.original.hold;
        if (!h?.name) return <span className="text-muted-foreground">—</span>;
        return h.customerId ? (
          <Link href={`/customers/${h.customerId}`} className="hover:underline">
            {h.name}
          </Link>
        ) : (
          h.name
        );
      },
    },
    {
      id: 'until',
      header: 'Hasta',
      cell: ({ row }) =>
        row.original.hold?.until ? (
          formatDate(row.original.hold.until)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];
  if (held.isError) return <SectionError onRetry={() => void held.refetch()} />;
  return (
    <DataTable
      columns={columns}
      data={held.data ?? []}
      isLoading={held.isLoading}
      emptyText="Ahora mismo no hay ningún trastero guardado."
    />
  );
}

/** Prorrogar, cambiar de inquilino o anotar. */
function EditReservationDialog({
  reservation,
  onClose,
}: {
  reservation: ReservationDto;
  onClose: () => void;
}) {
  const update = useUpdateReservation();
  const [until, setUntil] = useState(reservation.validUntil.slice(0, 10));
  const [customerId, setCustomerId] = useState<string | undefined>(
    reservation.customerId ?? undefined,
  );
  const [notes, setNotes] = useState(reservation.notes ?? '');

  async function submit() {
    const changedDate = until !== reservation.validUntil.slice(0, 10);
    try {
      await update.mutateAsync({
        id: reservation.id,
        input: {
          ...(changedDate ? { validUntil: new Date(`${until}T23:59:59`).toISOString() } : {}),
          ...((customerId ?? null) !== reservation.customerId
            ? { customerId: customerId ?? null }
            : {}),
          notes: notes.trim() || null,
        },
      });
      toast.success('Reserva actualizada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reserva del trastero {reservation.unitCode}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Reservado hasta</Label>
            <DateSelect
              years={2}
              future
              value={until || undefined}
              onChange={(v) => setUntil(v ?? '')}
            />
          </div>
          <div>
            <Label>Inquilino</Label>
            <CustomerSearchSelect
              value={customerId}
              onChange={setCustomerId}
              clearLabel="Sin inquilino"
              className="w-full"
            />
            {reservation.depositInvoiceId && (
              <p className="mt-1 text-xs text-muted-foreground">
                La señal ya está facturada: el inquilino no se puede cambiar.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="res-notes">Notas</Label>
            <Input id="res-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={!until || update.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Señal y lista de espera: cómo funciona en este negocio. */
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useReservationSettings();
  const update = useUpdateReservationSettings();
  const [policy, setPolicy] = useState<ReservationSignalPolicy | undefined>();
  const [hours, setHours] = useState('');
  const [stale, setStale] = useState('');
  const current = settings.data;

  async function submit() {
    try {
      await update.mutateAsync({
        ...(policy ? { signalPolicy: policy } : {}),
        ...(hours ? { waitlistHoldHours: Number(hours) } : {}),
        ...(stale ? { waitlistStaleDays: Number(stale) } : {}),
      });
      toast.success('Ajustes guardados.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reservas y lista de espera</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Si una reserva con la señal cobrada se cae</Label>
            <Select
              value={policy ?? current?.signalPolicy ?? 'refund'}
              onValueChange={(v) => setPolicy(v as ReservationSignalPolicy)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="refund">Se devuelve (abono en borrador)</SelectItem>
                <SelectItem value="keep">Se la queda el negocio</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              Comprueba que lo que elijas coincide con lo que dicen tus condiciones.
            </p>
          </div>
          <div>
            <Label htmlFor="wl-hours">Horas que se guarda el trastero al avisar</Label>
            <Input
              id="wl-hours"
              type="number"
              min={12}
              max={168}
              value={hours || String(current?.waitlistHoldHours ?? '')}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="wl-stale">Días en cola antes de preguntar «¿Sigues buscando?»</Label>
            <Input
              id="wl-stale"
              type="number"
              min={0}
              max={365}
              value={stale || String(current?.waitlistStaleDays ?? '')}
              onChange={(e) => setStale(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Con 0 no se pregunta. Quien no responde en 14 días sale de la cola.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={update.isPending}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reserva un trastero libre para un inquilino hasta una fecha. */
function NewReservationDialog({
  facilityId,
  onClose,
}: {
  facilityId: string | undefined;
  onClose: () => void;
}) {
  const units = useUnits({ status: 'available', ...(facilityId ? { facilityId } : {}) });
  const create = useCreateReservation();
  const [unitId, setUnitId] = useState('');
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [until, setUntil] = useState('');
  const [deposit, setDeposit] = useState('');

  async function submit() {
    try {
      const created = await create.mutateAsync({
        unitId,
        ...(customerId ? { customerId } : {}),
        validFrom: new Date().toISOString(),
        validUntil: new Date(`${until}T23:59:59`).toISOString(),
        depositAmount: Number(deposit) || 0,
        confirmImmediately: true,
      });
      if (Number(deposit) > 0 && !created.depositInvoiceId) {
        toast.warning('Trastero reservado, pero la señal no se ha podido facturar.');
      } else {
        toast.success('Trastero reservado.');
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reservar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva reserva</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Trastero</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
            >
              <option value="">Elige un trastero…</option>
              {(units.data?.items ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} · {u.facilityName} ({formatEur(u.basePriceMonthly)}/mes)
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Inquilino</Label>
            <CustomerSearchSelect
              value={customerId}
              onChange={setCustomerId}
              clearLabel="Sin inquilino"
              className="w-full"
            />
          </div>
          <div>
            <Label>Reservado hasta</Label>
            <DateSelect
              years={2}
              future
              value={until || undefined}
              onChange={(v) => setUntil(v ?? '')}
            />
          </div>
          <div>
            <Label htmlFor="res-deposit">Señal (€, opcional)</Label>
            <Input
              id="res-deposit"
              type="number"
              step="0.01"
              min={0}
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Necesita inquilino: se factura al crearla y se descuenta del primer alquiler.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!unitId || !until || create.isPending || (Number(deposit) > 0 && !customerId)}
          >
            Reservar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
