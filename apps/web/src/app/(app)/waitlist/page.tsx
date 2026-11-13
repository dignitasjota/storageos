'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Download, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { WaitlistDemandRowDto, WaitlistEntryDto, WaitlistStatus } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { EmailTypoHint } from '@/components/email-typo-hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { useFacilities, useUnitTypes, useUnits } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate } from '@/lib/format';
import {
  useCreateWaitlistEntry,
  usePreassignWaitlist,
  useUpcomingUnits,
  useUpdateWaitlistEntry,
  useWaitlist,
  useWaitlistAction,
  useWaitlistDemand,
} from '@/lib/waitlist/hooks';

const STATUS: Record<
  WaitlistStatus,
  { label: string; variant: 'secondary' | 'default' | 'outline' }
> = {
  waiting: { label: 'En espera', variant: 'secondary' },
  notified: { label: 'Avisado', variant: 'default' },
  converted: { label: 'Convertido', variant: 'outline' },
  cancelled: { label: 'Cancelado', variant: 'outline' },
  expired: { label: 'Aviso caducado', variant: 'outline' },
};

/** Lo que queda del aviso, en horas. */
function timeLeft(iso: string): string {
  const hours = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
  if (hours <= 0) return 'caduca ya';
  return hours < 48 ? `quedan ${hours} h` : `quedan ${Math.round(hours / 24)} días`;
}

export default function WaitlistPage() {
  const ask = useConfirm();
  const headerFacilityId = useHeaderFacilityId();
  const { data, isLoading, isError, refetch } = useWaitlist(
    headerFacilityId ? { facilityId: headerFacilityId } : {},
  );
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const create = useCreateWaitlistEntry();
  const update = useUpdateWaitlistEntry();
  const action = useWaitlistAction();
  const canWrite = useHasPermission('reservations:write');
  const canContract = useHasPermission('contracts:write');
  const [preassigning, setPreassigning] = useState<WaitlistEntryDto | null>(null);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    facilityId: '',
    unitTypeId: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    notes: '',
  });
  // Solo los tamaños que tiene el local elegido.
  const facilityUnits = useUnits(form.facilityId ? { facilityId: form.facilityId } : {});
  const facilityTypeIds = useMemo(
    () => new Set((facilityUnits.data?.items ?? []).map((u) => u.unitTypeId)),
    [facilityUnits.data],
  );

  async function onCreate() {
    if (!form.facilityId || !form.unitTypeId || !form.contactName || !form.contactEmail) {
      toast.error('Completa local, tipo, nombre y email.');
      return;
    }
    try {
      await create.mutateAsync({
        facilityId: form.facilityId,
        unitTypeId: form.unitTypeId,
        contactName: form.contactName,
        contactEmail: form.contactEmail,
        contactPhone: form.contactPhone.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast.success('Añadido a la lista de espera.');
      setOpen(false);
      setForm({
        facilityId: '',
        unitTypeId: '',
        contactName: '',
        contactEmail: '',
        contactPhone: '',
        notes: '',
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo añadir.');
    }
  }

  async function onUpdate(id: string, status: 'converted' | 'cancelled') {
    const ok = await ask(
      status === 'converted'
        ? {
            title: 'Marcar como convertido',
            description:
              'Sale de la cola. Si tiene un trastero guardado y no hay un contrato en borrador sobre él, se le ofrece al siguiente.',
            confirmLabel: 'Marcar',
          }
        : {
            title: 'Sacar de la lista de espera',
            description: 'Si tiene un trastero guardado, se le ofrece al siguiente.',
            confirmLabel: 'Sacar de la cola',
            destructive: true,
          },
    );
    if (!ok) return;
    try {
      await update.mutateAsync({ id, input: { status } });
      toast.success(status === 'converted' ? 'Marcado como convertido.' : 'Cancelado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error.');
    }
  }

  async function runAction(e: WaitlistEntryDto, kind: 'notify' | 'skip' | 'requeue') {
    if (kind === 'skip') {
      const ok = await ask({
        title: 'Ceder el turno',
        description:
          e.status === 'notified'
            ? 'Suelta el trastero guardado, se le ofrece al siguiente y esta persona vuelve a esperar detrás.'
            : 'Pasa detrás de la siguiente persona de la cola.',
        confirmLabel: 'Ceder el turno',
      });
      if (!ok) return;
    }
    try {
      await action.mutateAsync({ id: e.id, action: kind });
      toast.success(
        kind === 'notify'
          ? 'Avisado: le guardamos un trastero.'
          : kind === 'skip'
            ? 'Turno cedido.'
            : 'De vuelta en la cola.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error.');
    }
  }

  const rows = useMemo(() => data ?? [], [data]);
  const waiting = rows.filter((e) => e.status === 'waiting');
  const notified = rows.filter((e) => e.status === 'notified');
  const closed = rows.filter((e) => e.status !== 'waiting' && e.status !== 'notified');

  function exportCsv() {
    downloadCsv('lista-de-espera.csv', [
      ['Nombre', 'Email', 'Teléfono', 'Local', 'Tamaño', 'Estado', 'Posición', 'Desde'],
      ...rows.map((e) => [
        e.contactName,
        e.contactEmail,
        e.contactPhone ?? '',
        e.facilityName,
        e.unitTypeName,
        STATUS[e.status].label,
        e.position ?? '',
        formatDate(e.createdAt),
      ]),
    ]);
  }

  const columns: ColumnDef<WaitlistEntryDto>[] = [
    {
      id: 'contact',
      header: 'Contacto',
      cell: ({ row }) => {
        const e = row.original;
        return (
          <div>
            {e.customerId ? (
              <Link href={`/customers/${e.customerId}`} className="font-medium hover:underline">
                {e.contactName}
              </Link>
            ) : (
              <span className="font-medium">{e.contactName}</span>
            )}
            <div className="text-xs text-muted-foreground">
              {e.contactEmail}
              {e.contactPhone ? ` · ${e.contactPhone}` : ''}
            </div>
          </div>
        );
      },
    },
    {
      id: 'queue',
      header: 'Local y tamaño',
      cell: ({ row }) => (
        <span className="text-sm">
          {row.original.facilityName} · {row.original.unitTypeName}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const e = row.original;
        return (
          <div className="space-y-0.5">
            <Badge variant={STATUS[e.status].variant}>
              {e.position ? `${e.position}.º en la cola` : STATUS[e.status].label}
            </Badge>
            {e.heldUnitCode && (
              <p className="text-xs text-muted-foreground">
                Guardado: {e.heldUnitCode}
                {e.holdExpiresAt ? ` · ${timeLeft(e.holdExpiresAt)}` : ''}
              </p>
            )}
            {e.preassignedUnitCode && (
              <p className="text-xs text-muted-foreground">Preasignado: {e.preassignedUnitCode}</p>
            )}
            {e.status === 'waiting' && e.freeUnitAvailable && (
              <p className="text-xs text-emerald-600">Hay un trastero libre</p>
            )}
          </div>
        );
      },
    },
    {
      id: 'since',
      header: 'Desde',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const e = row.original;
        if (!canWrite) return null;
        const live = e.status === 'waiting' || e.status === 'notified';
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Acciones">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {live && canContract && (
                <DropdownMenuItem asChild>
                  <Link
                    href={`/contracts/new?${new URLSearchParams({
                      waitlistEntryId: e.id,
                      facilityId: e.facilityId,
                      unitTypeId: e.unitTypeId,
                      ...(e.customerId ? { customerId: e.customerId } : {}),
                      ...(e.heldUnitId ? { unitId: e.heldUnitId } : {}),
                    }).toString()}`}
                  >
                    Crear contrato
                  </Link>
                </DropdownMenuItem>
              )}
              {e.status === 'waiting' && e.freeUnitAvailable && (
                <DropdownMenuItem onClick={() => void runAction(e, 'notify')}>
                  Avisar ahora
                </DropdownMenuItem>
              )}
              {e.status === 'waiting' && (
                <DropdownMenuItem onClick={() => setPreassigning(e)}>
                  Preasignar un trastero con baja
                </DropdownMenuItem>
              )}
              {live && (
                <DropdownMenuItem onClick={() => void runAction(e, 'skip')}>
                  Ceder el turno
                </DropdownMenuItem>
              )}
              {live && (
                <DropdownMenuItem onClick={() => void onUpdate(e.id, 'converted')}>
                  Marcar como convertido
                </DropdownMenuItem>
              )}
              {live && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => void onUpdate(e.id, 'cancelled')}
                >
                  Sacar de la cola
                </DropdownMenuItem>
              )}
              {(e.status === 'expired' || e.status === 'cancelled') && (
                <DropdownMenuItem onClick={() => void runAction(e, 'requeue')}>
                  Volver a la cola
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const table = (list: WaitlistEntryDto[], emptyText: string) =>
    isError ? (
      <SectionError onRetry={() => void refetch()} />
    ) : (
      <DataTable columns={columns} data={list} isLoading={isLoading} emptyText={emptyText} />
    );

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Lista de espera</h1>
          <p className="text-sm text-muted-foreground">
            Clientes esperando un tipo de trastero. Al quedar uno libre, se avisa al primero de la
            cola y se le guarda.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="mr-1 size-4" /> CSV
          </Button>
          <Can permission="reservations:write">
            <Button onClick={() => setOpen(true)}>Añadir a la lista</Button>
          </Can>
        </div>
      </div>

      <Tabs defaultValue="waiting">
        <TabsList>
          <TabsTrigger value="waiting">En cola ({waiting.length})</TabsTrigger>
          <TabsTrigger value="notified">Avisados ({notified.length})</TabsTrigger>
          <TabsTrigger value="closed">Cerrados ({closed.length})</TabsTrigger>
          <TabsTrigger value="demand">Demanda</TabsTrigger>
        </TabsList>
        <TabsContent value="waiting" className="mt-4">
          {table(waiting, 'Nadie en lista de espera.')}
        </TabsContent>
        <TabsContent value="notified" className="mt-4">
          {table(notified, 'No hay avisos en curso.')}
        </TabsContent>
        <TabsContent value="closed" className="mt-4">
          {table(closed, 'Aún no hay entradas cerradas.')}
        </TabsContent>
        <TabsContent value="demand" className="mt-4">
          <DemandTab facilityId={headerFacilityId} />
        </TabsContent>
      </Tabs>

      {preassigning && (
        <PreassignDialog entry={preassigning} onClose={() => setPreassigning(null)} />
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Añadir a la lista de espera</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Local</Label>
                <Select
                  value={form.facilityId}
                  onValueChange={(v) => setForm((f) => ({ ...f, facilityId: v, unitTypeId: '' }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Elige un local" />
                  </SelectTrigger>
                  <SelectContent>
                    {(facilities.data ?? []).map((fac) => (
                      <SelectItem key={fac.id} value={fac.id}>
                        {fac.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Tipo de trastero</Label>
                <Select
                  value={form.unitTypeId}
                  onValueChange={(v) => setForm((f) => ({ ...f, unitTypeId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Elige un tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    {(unitTypes.data ?? [])
                      .filter((t) => !form.facilityId || facilityTypeIds.has(t.id))
                      .map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input
                value={form.contactName}
                onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.contactEmail}
                  onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
                />
                <EmailTypoHint
                  value={form.contactEmail}
                  onAccept={(contactEmail) => setForm((f) => ({ ...f, contactEmail }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Teléfono (opcional)</Label>
                <Input
                  value={form.contactPhone}
                  onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Notas (opcional)</Label>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={onCreate} disabled={create.isPending}>
              {create.isPending ? 'Añadiendo…' : 'Añadir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Cuánta gente espera por local y tamaño. */
function DemandTab({ facilityId }: { facilityId: string | undefined }) {
  const demand = useWaitlistDemand(facilityId);
  const columns: ColumnDef<WaitlistDemandRowDto>[] = [
    {
      id: 'queue',
      header: 'Local y tamaño',
      cell: ({ row }) => `${row.original.facilityName} · ${row.original.unitTypeName}`,
    },
    { accessorKey: 'waiting', header: 'Esperando' },
    {
      accessorKey: 'oldestDays',
      header: 'Espera más larga',
      cell: ({ row }) => (row.original.waiting ? `${row.original.oldestDays} días` : '—'),
    },
    { accessorKey: 'freeUnits', header: 'Libres ahora' },
    {
      id: 'conversion',
      header: 'Avisos que acaban en contrato',
      cell: ({ row }) =>
        row.original.conversionPct === null
          ? '—'
          : `${row.original.conversionPct} % (${row.original.converted} de ${
              row.original.converted + row.original.expired
            })`,
    },
  ];
  if (demand.isError) return <SectionError onRetry={() => void demand.refetch()} />;
  return (
    <DataTable
      columns={columns}
      data={demand.data ?? []}
      isLoading={demand.isLoading}
      emptyText="Todavía no hay demanda registrada."
    />
  );
}

/** Reserva para esta persona un trastero que se va a liberar. */
function PreassignDialog({ entry, onClose }: { entry: WaitlistEntryDto; onClose: () => void }) {
  const units = useUpcomingUnits(entry.id);
  const preassign = usePreassignWaitlist();

  async function choose(unitId: string | null) {
    try {
      await preassign.mutateAsync({ id: entry.id, unitId });
      toast.success(unitId ? 'Trastero preasignado.' : 'Preasignación quitada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Preasignar a {entry.contactName}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Cuando el inquilino actual se vaya, el aviso irá a esta persona antes que al resto de la
          cola.
        </p>
        {units.isError ? (
          <SectionError onRetry={() => void units.refetch()} />
        ) : (units.data ?? []).length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {units.isLoading
              ? 'Cargando…'
              : `No hay ningún ${entry.unitTypeName} con baja pedida en ${entry.facilityName}.`}
          </p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {(units.data ?? []).map((u) => (
              <li key={u.unitId} className="flex items-center justify-between gap-3 p-2">
                <span>
                  {u.unitCode} · queda libre el {formatDate(u.endDate)}
                  {u.preassignedTo ? ` · preasignado a ${u.preassignedTo}` : ''}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={preassign.isPending || !!u.preassignedTo}
                  onClick={() => void choose(u.unitId)}
                >
                  Elegir
                </Button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          {entry.preassignedUnitId && (
            <Button variant="outline" onClick={() => void choose(null)}>
              Quitar la preasignación
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
