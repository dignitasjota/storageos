'use client';

import { type AccessCredentialDto, type AccessHolderKindValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  useCreateTemporaryAccess,
  useRevokeCredential,
  useTemporaryAccess,
} from '@/lib/access/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDateTime } from '@/lib/format';

const KINDS: Record<AccessHolderKindValue, string> = {
  supplier: 'Proveedor',
  staff: 'Equipo',
  other: 'Otro',
};

const STATUS: Record<string, string> = {
  active: 'Activo',
  suspended: 'Suspendido',
  revoked: 'Revocado',
  expired: 'Caducado',
  pending: 'Pendiente',
};

/** Accesos con fecha de fin para quien no es inquilino: limpieza, mantenimiento, equipo. */
export default function TemporaryAccessPage() {
  const canManage = useHasPermission('access:manage');
  const list = useTemporaryAccess();
  const revoke = useRevokeCredential();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState<{ name: string; code: string } | null>(null);

  const columns: ColumnDef<AccessCredentialDto>[] = [
    {
      accessorKey: 'customerName',
      header: 'Quién',
      cell: ({ row }) => <span className="font-medium">{row.original.customerName}</span>,
    },
    {
      accessorKey: 'holderKind',
      header: 'Tipo',
      cell: ({ row }) => KINDS[row.original.holderKind as AccessHolderKindValue] ?? '—',
    },
    {
      accessorKey: 'validFrom',
      header: 'Desde',
      cell: ({ row }) =>
        formatDateTime(
          row.original.validFrom ?? row.original.activatedAt ?? row.original.createdAt,
        ),
    },
    {
      accessorKey: 'expiresAt',
      header: 'Hasta',
      cell: ({ row }) => (row.original.expiresAt ? formatDateTime(row.original.expiresAt) : '—'),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => STATUS[row.original.status] ?? row.original.status,
    },
    {
      accessorKey: 'lastUsedAt',
      header: 'Último uso',
      cell: ({ row }) => (row.original.lastUsedAt ? formatDateTime(row.original.lastUsedAt) : '—'),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canManage && row.original.status === 'active' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={revoke.isPending}
            onClick={() =>
              void revoke
                .mutateAsync(row.original.id)
                .then(() => toast.success('Acceso retirado.'))
                .catch(() => toast.error('No se ha podido retirar.'))
            }
          >
            Retirar
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Para proveedores y personas del equipo. Dejan de abrir solos en la fecha de fin.
      </p>
      {list.isError && !list.data ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={list.data ?? []}
          isLoading={list.isLoading}
          searchPlaceholder="Buscar..."
          emptyText="Da acceso a la empresa de limpieza o de mantenimiento durante unos días."
          toolbarRight={
            canManage ? (
              <Button onClick={() => setOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> Nuevo acceso temporal
              </Button>
            ) : null
          }
        />
      )}
      {open && (
        <TemporaryDialog
          onClose={() => setOpen(false)}
          onCreated={(name, code) => {
            setOpen(false);
            if (code) setPin({ name, code });
          }}
        />
      )}
      <Dialog open={!!pin} onOpenChange={(o) => !o && setPin(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>PIN de {pin?.name}</DialogTitle>
          </DialogHeader>
          <p className="font-mono text-3xl font-semibold tracking-widest">{pin?.code}</p>
          <p className="text-sm text-muted-foreground">Guárdalo ahora: no se mostrará otra vez.</p>
          <DialogFooter>
            <Button onClick={() => setPin(null)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TemporaryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string, code: string | null) => void;
}) {
  const create = useCreateTemporaryAccess();
  const facilities = useFacilities();
  const [holderName, setHolderName] = useState('');
  const [holderKind, setHolderKind] = useState<AccessHolderKindValue>('supplier');
  const [facilityIds, setFacilityIds] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [bypassCurfew, setBypassCurfew] = useState(false);

  async function submit() {
    try {
      const dto = await create.mutateAsync({
        holderName: holderName.trim(),
        holderKind,
        method: 'pin',
        allowedFacilityIds: facilityIds,
        allowedUnitIds: [],
        allowedHours: { windows: [] },
        bypassCurfew,
        ...(from ? { validFrom: new Date(from).toISOString() } : {}),
        expiresAt: new Date(to).toISOString(),
      });
      toast.success('Acceso creado.');
      onCreated(dto.customerName, dto.revealedSecret);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido crear.');
    }
  }

  const valid =
    holderName.trim().length >= 2 &&
    facilityIds.length > 0 &&
    !!to &&
    new Date(to) > new Date(from || Date.now());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo acceso temporal</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tmp-name">Quién</Label>
            <Input
              id="tmp-name"
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              placeholder="Ej: Limpiezas Sol"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Tipo</Label>
            <Select
              value={holderKind}
              onValueChange={(v) => setHolderKind(v as AccessHolderKindValue)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KINDS) as AccessHolderKindValue[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KINDS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Locales</Label>
            <div className="space-y-1.5 rounded-md border p-2">
              {(facilities.data ?? []).map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={facilityIds.includes(f.id)}
                    onCheckedChange={(v) =>
                      setFacilityIds((ids) =>
                        v === true ? [...ids, f.id] : ids.filter((id) => id !== f.id),
                      )
                    }
                  />
                  {f.name}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tmp-from">Desde (opcional)</Label>
              <Input
                id="tmp-from"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tmp-to">Hasta</Label>
              <Input
                id="tmp-to"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={bypassCurfew} onCheckedChange={(v) => setBypassCurfew(v === true)} />
            Entra también durante el toque de queda del local
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!valid || create.isPending} onClick={() => void submit()}>
            {create.isPending ? 'Creando...' : 'Crear'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
