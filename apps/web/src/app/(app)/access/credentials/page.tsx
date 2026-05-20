'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type AccessCredentialDto,
  type AccessCredentialStatusValue,
  type AccessCredentialWithSecretDto,
  type AccessMethodValue,
  type CreateCredentialInput,
  CreateCredentialSchema,
  type RotateCredentialInput,
  RotateCredentialSchema,
  type SuspendCredentialInput,
  SuspendCredentialSchema,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import {
  Copy,
  CreditCard,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  QrCode,
  RotateCw,
  ShieldOff,
  Pause,
  Play,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCreateCredential,
  useCredentials,
  useResumeCredential,
  useRevokeCredential,
  useRotateCredential,
  useSuspendCredential,
} from '@/lib/access/hooks';
import { ApiError } from '@/lib/auth/api';
import { useCustomers } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const METHOD_LABELS: Record<AccessMethodValue, { label: string; Icon: React.ElementType }> = {
  pin: { label: 'PIN', Icon: KeyRound },
  qr: { label: 'QR', Icon: QrCode },
  rfid: { label: 'RFID', Icon: CreditCard },
};

const STATUS_LABELS: Record<AccessCredentialStatusValue, { label: string; className: string }> = {
  pending: { label: 'Pendiente', className: 'bg-slate-100 text-slate-700' },
  active: { label: 'Activa', className: 'bg-green-100 text-green-700' },
  suspended: { label: 'Suspendida', className: 'bg-orange-100 text-orange-700' },
  revoked: { label: 'Revocada', className: 'bg-red-100 text-red-700' },
  expired: { label: 'Expirada', className: 'bg-slate-300 text-slate-800' },
};

export default function CredentialsPage() {
  const [status, setStatus] = useState<AccessCredentialStatusValue | undefined>();
  const [method, setMethod] = useState<AccessMethodValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<AccessCredentialWithSecretDto | null>(null);
  const [rotateTarget, setRotateTarget] = useState<AccessCredentialDto | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<AccessCredentialDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AccessCredentialDto | null>(null);

  const credentials = useCredentials({
    ...(status ? { status } : {}),
    ...(method ? { method } : {}),
    ...(customerId ? { customerId } : {}),
  });
  const customers = useCustomers();
  const resume = useResumeCredential();

  async function handleResume(cred: AccessCredentialDto) {
    try {
      await resume.mutateAsync(cred.id);
      toast.success('Credencial reanudada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const columns: ColumnDef<AccessCredentialDto>[] = [
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) => <span className="font-medium">{row.original.customerName}</span>,
    },
    {
      accessorKey: 'method',
      header: 'Método',
      cell: ({ row }) => {
        const m = METHOD_LABELS[row.original.method];
        const Icon = m.Icon;
        return (
          <div className="flex items-center gap-1.5 text-sm">
            <Icon className="size-4 text-muted-foreground" />
            <span>{m.label}</span>
          </div>
        );
      },
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS_LABELS[row.original.status];
        return (
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${s.className}`}>
            {s.label}
          </span>
        );
      },
    },
    {
      accessorKey: 'secretPreview',
      header: 'Secreto',
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.secretPreview ?? '—'}
        </span>
      ),
    },
    {
      accessorKey: 'allowedFacilityIds',
      header: 'Locales',
      cell: ({ row }) => {
        const count = row.original.allowedFacilityIds.length;
        return (
          <Badge variant="outline">
            {count === 0 ? 'Todos' : `${count} local${count === 1 ? '' : 'es'}`}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'expiresAt',
      header: 'Expira',
      cell: ({ row }) =>
        row.original.expiresAt ? new Date(row.original.expiresAt).toLocaleDateString('es-ES') : '—',
    },
    {
      accessorKey: 'createdAt',
      header: 'Creada',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString('es-ES'),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const cred = row.original;
        const isTerminal = cred.status === 'revoked' || cred.status === 'expired';
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={isTerminal} onClick={() => setRotateTarget(cred)}>
                <RotateCw className="mr-2 h-4 w-4" />
                Rotar
              </DropdownMenuItem>
              {cred.status === 'suspended' ? (
                <DropdownMenuItem onClick={() => handleResume(cred)} disabled={resume.isPending}>
                  <Play className="mr-2 h-4 w-4" />
                  Reanudar
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={isTerminal || cred.status === 'pending'}
                  onClick={() => setSuspendTarget(cred)}
                >
                  <Pause className="mr-2 h-4 w-4" />
                  Suspender
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isTerminal}
                onClick={() => setRevokeTarget(cred)}
                className="text-red-600 focus:text-red-600"
              >
                <ShieldOff className="mr-2 h-4 w-4" />
                Revocar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  if (credentials.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select
          value={status ?? 'all'}
          onValueChange={(v) =>
            setStatus(v === 'all' ? undefined : (v as AccessCredentialStatusValue))
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as AccessCredentialStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={method ?? 'all'}
          onValueChange={(v) => setMethod(v === 'all' ? undefined : (v as AccessMethodValue))}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Método" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los métodos</SelectItem>
            {(Object.keys(METHOD_LABELS) as AccessMethodValue[]).map((m) => (
              <SelectItem key={m} value={m}>
                {METHOD_LABELS[m].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={customerId ?? 'all'}
          onValueChange={(v) => setCustomerId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Inquilino" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los inquilinos</SelectItem>
            {(customers.data ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={credentials.data ?? []}
        isLoading={credentials.isLoading}
        searchPlaceholder="Buscar por inquilino..."
        emptyText="No hay credenciales. Crea la primera para empezar."
        toolbarRight={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Nueva credencial
          </Button>
        }
      />

      {createOpen && (
        <CreateCredentialDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onRevealed={(dto) => {
            setRevealed(dto);
            setCreateOpen(false);
          }}
        />
      )}

      {rotateTarget && (
        <RotateCredentialDialog
          credential={rotateTarget}
          onClose={() => setRotateTarget(null)}
          onRevealed={(dto) => {
            setRevealed(dto);
            setRotateTarget(null);
          }}
        />
      )}

      {suspendTarget && (
        <SuspendCredentialDialog
          credential={suspendTarget}
          onClose={() => setSuspendTarget(null)}
        />
      )}

      {revokeTarget && (
        <RevokeCredentialDialog credential={revokeTarget} onClose={() => setRevokeTarget(null)} />
      )}

      {revealed && <RevealedSecretDialog credential={revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

// ============================================================================
// Create credential
// ============================================================================

function CreateCredentialDialog({
  open,
  onClose,
  onRevealed,
}: {
  open: boolean;
  onClose: () => void;
  onRevealed: (dto: AccessCredentialWithSecretDto) => void;
}) {
  const create = useCreateCredential();
  const customers = useCustomers();
  const facilities = useFacilities();

  const form = useForm<CreateCredentialInput>({
    resolver: zodResolver(CreateCredentialSchema),
    defaultValues: {
      method: 'pin',
      customerId: '',
      allowedFacilityIds: [],
      allowedUnitIds: [],
      allowedHours: {},
      metadata: {},
    },
  });

  const selectedMethod = form.watch('method');
  const selectedFacilities = form.watch('allowedFacilityIds') ?? [];

  async function onSubmit(values: CreateCredentialInput) {
    try {
      const payload: CreateCredentialInput = {
        method: values.method,
        customerId: values.customerId,
        allowedFacilityIds: values.allowedFacilityIds ?? [],
        allowedUnitIds: values.allowedUnitIds ?? [],
        allowedHours: values.allowedHours ?? {},
        metadata: values.metadata ?? {},
        ...(values.label ? { label: values.label } : {}),
        ...(values.method === 'pin' && values.pin ? { pin: values.pin } : {}),
        ...(values.method === 'rfid' && values.rfidUid ? { rfidUid: values.rfidUid } : {}),
        ...(values.expiresAt ? { expiresAt: values.expiresAt } : {}),
        ...(values.contractId ? { contractId: values.contractId } : {}),
      };
      const dto = await create.mutateAsync(payload);
      toast.success('Credencial creada.');
      form.reset();
      onRevealed(dto);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  function toggleFacility(id: string, checked: boolean) {
    const current = form.getValues('allowedFacilityIds') ?? [];
    form.setValue(
      'allowedFacilityIds',
      checked ? [...current, id] : current.filter((x) => x !== id),
      { shouldValidate: true, shouldDirty: true },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva credencial</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Inquilino</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? ''}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecciona inquilino" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(customers.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.displayName}
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
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Método</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? 'pin'}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(Object.keys(METHOD_LABELS) as AccessMethodValue[]).map((m) => (
                        <SelectItem key={m} value={m}>
                          {METHOD_LABELS[m].label}
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
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Etiqueta (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      placeholder="Ej: Tarjeta principal"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {selectedMethod === 'pin' && (
              <FormField
                control={form.control}
                name="pin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>PIN (opcional, se genera si lo dejas vacío)</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        placeholder="4-8 dígitos"
                        inputMode="numeric"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {selectedMethod === 'rfid' && (
              <FormField
                control={form.control}
                name="rfidUid"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>UID RFID</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} placeholder="Ej: 04A3B2C1D5" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="expiresAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Expira (opcional)</FormLabel>
                  <FormControl>
                    <Input
                      type="datetime-local"
                      value={field.value ? field.value.slice(0, 16) : ''}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value ? new Date(e.target.value).toISOString() : undefined,
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <Label>Locales permitidos (vacío = todos)</Label>
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-2">
                {(facilities.data ?? []).length === 0 && (
                  <p className="text-xs text-muted-foreground">No hay locales disponibles.</p>
                )}
                {(facilities.data ?? []).map((f) => {
                  const checked = selectedFacilities.includes(f.id);
                  return (
                    <label key={f.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggleFacility(f.id, v === true)}
                      />
                      <span>{f.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
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
// Rotate credential
// ============================================================================

function RotateCredentialDialog({
  credential,
  onClose,
  onRevealed,
}: {
  credential: AccessCredentialDto;
  onClose: () => void;
  onRevealed: (dto: AccessCredentialWithSecretDto) => void;
}) {
  const rotate = useRotateCredential();
  const form = useForm<RotateCredentialInput>({
    resolver: zodResolver(RotateCredentialSchema),
    defaultValues: {},
  });

  async function onSubmit(values: RotateCredentialInput) {
    try {
      const payload: RotateCredentialInput = {
        ...(credential.method === 'pin' && values.pin ? { pin: values.pin } : {}),
        ...(credential.method === 'rfid' && values.rfidUid ? { rfidUid: values.rfidUid } : {}),
      };
      const dto = await rotate.mutateAsync({ id: credential.id, input: payload });
      toast.success('Credencial rotada.');
      onRevealed(dto);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rotar credencial</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Esta acción invalida el secreto anterior y genera uno nuevo. El cliente deberá usar el
          nuevo a partir de ya.
        </p>
        <Form {...form}>
          <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            {credential.method === 'pin' && (
              <FormField
                control={form.control}
                name="pin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nuevo PIN (opcional, se genera si vacío)</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        placeholder="4-8 dígitos"
                        inputMode="numeric"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {credential.method === 'rfid' && (
              <FormField
                control={form.control}
                name="rfidUid"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nuevo UID RFID</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} placeholder="Ej: 04A3B2C1D5" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={rotate.isPending}>
                {rotate.isPending ? 'Rotando...' : 'Rotar'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Suspend credential
// ============================================================================

function SuspendCredentialDialog({
  credential,
  onClose,
}: {
  credential: AccessCredentialDto;
  onClose: () => void;
}) {
  const suspend = useSuspendCredential();
  const form = useForm<SuspendCredentialInput>({
    resolver: zodResolver(SuspendCredentialSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: SuspendCredentialInput) {
    try {
      await suspend.mutateAsync({ id: credential.id, input: values });
      toast.success('Credencial suspendida.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Suspender credencial</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          La credencial dejará de funcionar hasta que la reanudes.
        </p>
        <Form {...form}>
          <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Motivo</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ''}
                      placeholder="Ej: impago, pérdida de tarjeta..."
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
              <Button type="submit" disabled={suspend.isPending}>
                {suspend.isPending ? 'Suspendiendo...' : 'Suspender'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Revoke credential
// ============================================================================

function RevokeCredentialDialog({
  credential,
  onClose,
}: {
  credential: AccessCredentialDto;
  onClose: () => void;
}) {
  const revoke = useRevokeCredential();

  async function handleRevoke() {
    try {
      await revoke.mutateAsync(credential.id);
      toast.success('Credencial revocada.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Revocar credencial</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Esta acción es <strong>irreversible</strong>. La credencial quedará permanentemente
          inactiva.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleRevoke}
            disabled={revoke.isPending}
          >
            {revoke.isPending ? 'Revocando...' : 'Revocar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Revealed secret dialog (shown after create / rotate)
// ============================================================================

function RevealedSecretDialog({
  credential,
  onClose,
}: {
  credential: AccessCredentialWithSecretDto;
  onClose: () => void;
}) {
  async function copy() {
    if (!credential.revealedSecret) return;
    try {
      await navigator.clipboard.writeText(credential.revealedSecret);
      toast.success('Copiado al portapapeles.');
    } catch {
      toast.error('No se pudo copiar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Credencial generada</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-amber-50 p-3 text-sm text-amber-900">
            Guarda este código ahora. <strong>No se mostrará otra vez.</strong>
          </div>
          {credential.revealedSecret ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 font-mono text-lg">
              <span className="flex-1 break-all">{credential.revealedSecret}</span>
              <Button type="button" size="icon" variant="ghost" onClick={copy}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              UID RFID guardado: <span className="font-mono">{credential.rfidUid}</span>
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Inquilino: <strong>{credential.customerName}</strong> · Método:{' '}
            <strong>{METHOD_LABELS[credential.method].label}</strong>
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
