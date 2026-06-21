'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type AccessDeviceDto,
  type AccessDeviceTypeValue,
  type AccessDeviceWithKeyDto,
  type CreateDeviceInput,
  CreateDeviceSchema,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import {
  Copy,
  DoorOpen,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  RotateCw,
  Signal,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
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
import {
  useCreateDevice,
  useDeleteDevice,
  useOpenDevice,
  useDevices,
  usePingDevice,
  useRegenerateApiKey,
} from '@/lib/access/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const TYPE_LABELS: Record<AccessDeviceTypeValue, string> = {
  door: 'Puerta principal',
  unit_lock: 'Cerradura trastero',
  gate: 'Cancela / verja',
  other: 'Otro',
};

const TYPE_ICONS: Record<AccessDeviceTypeValue, React.ElementType> = {
  door: DoorOpen,
  unit_lock: Lock,
  gate: DoorOpen,
  other: Signal,
};

export default function DevicesPage() {
  const canManage = useHasPermission('access:manage');
  const [facilityId, setFacilityId] = useState<string | undefined>();
  const [type, setType] = useState<AccessDeviceTypeValue | undefined>();
  const [onlineFilter, setOnlineFilter] = useState<'all' | 'online' | 'offline'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<AccessDeviceWithKeyDto | null>(null);
  const [regenerateTarget, setRegenerateTarget] = useState<AccessDeviceDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccessDeviceDto | null>(null);

  const devices = useDevices({
    ...(facilityId ? { facilityId } : {}),
    ...(type ? { type } : {}),
  });
  const ping = usePingDevice();
  const openDevice = useOpenDevice();

  const filteredDevices = (devices.data ?? []).filter((d) => {
    if (onlineFilter === 'online') return d.isOnline;
    if (onlineFilter === 'offline') return !d.isOnline;
    return true;
  });

  async function handlePing(device: AccessDeviceDto) {
    try {
      const res = await ping.mutateAsync(device.id);
      toast.success(
        res.isOnline ? `${device.name} está online.` : `${device.name} no responde (offline).`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleOpen(device: AccessDeviceDto) {
    try {
      const res = await openDevice.mutateAsync(device.id);
      if (res.dispatched) toast.success(`Comando de apertura enviado a ${device.name}.`);
      else toast.error(`No se pudo abrir ${device.name}${res.message ? `: ${res.message}` : ''}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<AccessDeviceDto>[] = [
    {
      accessorKey: 'isOnline',
      header: '',
      cell: ({ row }) => (
        <span
          className={`inline-block size-2.5 rounded-full ${
            row.original.isOnline ? 'bg-green-500' : 'bg-slate-300'
          }`}
          aria-label={row.original.isOnline ? 'online' : 'offline'}
        />
      ),
    },
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: 'type',
      header: 'Tipo',
      cell: ({ row }) => {
        const Icon = TYPE_ICONS[row.original.type];
        return (
          <div className="flex items-center gap-1.5 text-sm">
            <Icon className="size-4 text-muted-foreground" />
            <span>{TYPE_LABELS[row.original.type]}</span>
          </div>
        );
      },
    },
    {
      accessorKey: 'facilityName',
      header: 'Local',
      cell: ({ row }) => row.original.facilityName,
    },
    {
      accessorKey: 'unitCode',
      header: 'Trastero',
      cell: ({ row }) => row.original.unitCode ?? '—',
    },
    {
      accessorKey: 'hardwareId',
      header: 'Hardware ID',
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.hardwareId}</span>,
    },
    {
      accessorKey: 'lastSeenAt',
      header: 'Última conexión',
      cell: ({ row }) =>
        row.original.lastSeenAt ? new Date(row.original.lastSeenAt).toLocaleString('es-ES') : '—',
    },
    {
      accessorKey: 'isActive',
      header: 'Estado',
      cell: ({ row }) =>
        row.original.isActive ? (
          <Badge variant="default">Activo</Badge>
        ) : (
          <Badge variant="outline">Inactivo</Badge>
        ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const device = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canManage && (
                <DropdownMenuItem
                  onClick={() => handleOpen(device)}
                  disabled={openDevice.isPending}
                >
                  <DoorOpen className="mr-2 h-4 w-4" />
                  Abrir (remoto)
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => handlePing(device)} disabled={ping.isPending}>
                <Signal className="mr-2 h-4 w-4" />
                Hacer ping
              </DropdownMenuItem>
              {canManage && (
                <>
                  <DropdownMenuItem onClick={() => setRegenerateTarget(device)}>
                    <RotateCw className="mr-2 h-4 w-4" />
                    Regenerar API key
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDeleteTarget(device)}
                    className="text-red-600 focus:text-red-600"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Eliminar
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  if (devices.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <FacilityFilter value={facilityId} onChange={setFacilityId} />
        <Select
          value={type ?? 'all'}
          onValueChange={(v) => setType(v === 'all' ? undefined : (v as AccessDeviceTypeValue))}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tipos</SelectItem>
            {(Object.keys(TYPE_LABELS) as AccessDeviceTypeValue[]).map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={onlineFilter}
          onValueChange={(v) => setOnlineFilter(v as 'all' | 'online' | 'offline')}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Online y offline</SelectItem>
            <SelectItem value="online">Solo online</SelectItem>
            <SelectItem value="offline">Solo offline</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={filteredDevices}
        isLoading={devices.isLoading}
        searchPlaceholder="Buscar por nombre..."
        emptyText="No hay dispositivos. Crea el primero para empezar."
        toolbarRight={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Nuevo dispositivo
            </Button>
          ) : null
        }
      />

      {createOpen && (
        <CreateDeviceDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onRevealed={(dto) => {
            setRevealed(dto);
            setCreateOpen(false);
          }}
        />
      )}

      {regenerateTarget && (
        <RegenerateKeyDialog
          device={regenerateTarget}
          onClose={() => setRegenerateTarget(null)}
          onRevealed={(dto) => {
            setRevealed(dto);
            setRegenerateTarget(null);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteDeviceDialog device={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}

      {revealed && <RevealedKeyDialog device={revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

function FacilityFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const facilities = useFacilities();
  return (
    <Select value={value ?? 'all'} onValueChange={(v) => onChange(v === 'all' ? undefined : v)}>
      <SelectTrigger className="w-[220px]">
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
  );
}

// ============================================================================
// Create device
// ============================================================================

function CreateDeviceDialog({
  open,
  onClose,
  onRevealed,
}: {
  open: boolean;
  onClose: () => void;
  onRevealed: (dto: AccessDeviceWithKeyDto) => void;
}) {
  const create = useCreateDevice();
  const facilities = useFacilities();

  const form = useForm<CreateDeviceInput>({
    resolver: zodResolver(CreateDeviceSchema),
    defaultValues: {
      facilityId: '',
      type: 'door',
      name: '',
      hardwareId: '',
      mqttTopic: '',
      controlUrl: '',
      controlSecret: '',
      metadata: {},
    },
  });

  async function onSubmit(values: CreateDeviceInput) {
    try {
      const payload: CreateDeviceInput = {
        facilityId: values.facilityId,
        type: values.type,
        name: values.name,
        hardwareId: values.hardwareId,
        metadata: values.metadata ?? {},
        ...(values.unitId ? { unitId: values.unitId } : {}),
        ...(values.mqttTopic ? { mqttTopic: values.mqttTopic } : {}),
        ...(values.controlUrl ? { controlUrl: values.controlUrl } : {}),
        ...(values.controlSecret ? { controlSecret: values.controlSecret } : {}),
      };
      const dto = await create.mutateAsync(payload);
      toast.success('Dispositivo creado.');
      form.reset();
      onRevealed(dto);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuevo dispositivo</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="facilityId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Local</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? ''}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecciona local" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(facilities.data ?? []).map((f) => (
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tipo</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? 'door'}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(Object.keys(TYPE_LABELS) as AccessDeviceTypeValue[]).map((t) => (
                          <SelectItem key={t} value={t}>
                            {TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nombre</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} placeholder="Puerta entrada" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="hardwareId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hardware ID</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} placeholder="Ej: ESP32-A1B2C3" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mqttTopic"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>MQTT topic (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      placeholder="storageos/devices/door-01"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="controlUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>URL de control HTTP (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      placeholder="https://controlador.local/open"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="controlSecret"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Secreto HMAC del controlador (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="password"
                      value={field.value ?? ''}
                      placeholder="mínimo 8 caracteres"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creando...' : 'Crear'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Regenerate API key
// ============================================================================

function RegenerateKeyDialog({
  device,
  onClose,
  onRevealed,
}: {
  device: AccessDeviceDto;
  onClose: () => void;
  onRevealed: (dto: AccessDeviceWithKeyDto) => void;
}) {
  const regenerate = useRegenerateApiKey();

  async function handleRegenerate() {
    try {
      const dto = await regenerate.mutateAsync(device.id);
      toast.success('API key regenerada.');
      onRevealed(dto);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Regenerar API key</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          La API key actual del dispositivo <strong>{device.name}</strong> dejará de funcionar.
          Tendrás que reconfigurar el dispositivo con la nueva.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={handleRegenerate} disabled={regenerate.isPending}>
            {regenerate.isPending ? 'Regenerando...' : 'Regenerar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Delete device
// ============================================================================

function DeleteDeviceDialog({ device, onClose }: { device: AccessDeviceDto; onClose: () => void }) {
  const del = useDeleteDevice();

  async function handleDelete() {
    try {
      await del.mutateAsync(device.id);
      toast.success('Dispositivo eliminado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Eliminar dispositivo</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          ¿Seguro que quieres eliminar <strong>{device.name}</strong>? Esta acción es irreversible.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={del.isPending}
          >
            {del.isPending ? 'Eliminando...' : 'Eliminar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Revealed API key (shown after create / regenerate)
// ============================================================================

function RevealedKeyDialog({
  device,
  onClose,
}: {
  device: AccessDeviceWithKeyDto;
  onClose: () => void;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(device.revealedApiKey);
      toast.success('Copiado al portapapeles.');
    } catch {
      toast.error('No se pudo copiar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>API key del dispositivo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-amber-50 p-3 text-sm text-amber-900">
            Guarda esta API key ahora. <strong>No se mostrará otra vez.</strong>
          </div>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm">
            <span className="flex-1 break-all">{device.revealedApiKey}</span>
            <Button type="button" size="icon" variant="ghost" onClick={copy}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Dispositivo: <strong>{device.name}</strong> · Hardware ID:{' '}
            <span className="font-mono">{device.hardwareId}</span>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
