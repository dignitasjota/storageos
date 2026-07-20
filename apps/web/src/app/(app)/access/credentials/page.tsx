'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type AccessCredentialDto,
  type AccessCredentialStatusValue,
  type AccessCredentialWithSecretDto,
  type AccessMethodValue,
  type AccessWindow,
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
  ScanFace,
  Trash2,
  ShieldOff,
  Pause,
  Play,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  useCreateFacialCredential,
  useCredentials,
  useResumeCredential,
  useRevokeCredential,
  useRotateCredential,
  useSuspendCredential,
} from '@/lib/access/hooks';
import { useAccessSettings, useUpdateAccessSettings } from '@/lib/access/settings-hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useCustomers } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

const METHOD_LABELS: Record<AccessMethodValue, { label: string; Icon: React.ElementType }> = {
  pin: { label: 'PIN', Icon: KeyRound },
  qr: { label: 'QR', Icon: QrCode },
  rfid: { label: 'RFID', Icon: CreditCard },
  face: { label: 'Facial', Icon: ScanFace },
};

const STATUS_LABELS: Record<AccessCredentialStatusValue, { label: string; className: string }> = {
  pending: {
    label: 'Pendiente',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  active: {
    label: 'Activa',
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  suspended: {
    label: 'Suspendida',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  },
  revoked: {
    label: 'Revocada',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  expired: { label: 'Expirada', className: 'bg-slate-300 text-slate-800' },
};

export default function CredentialsPage() {
  const canManage = useHasPermission('access:manage');
  const hasFacial = useHasFeature('facial_access');
  const [status, setStatus] = useState<AccessCredentialStatusValue | undefined>();
  const [method, setMethod] = useState<AccessMethodValue | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [facialOpen, setFacialOpen] = useState(false);
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
        const isNightPass =
          row.original.label === 'Pase nocturno' ||
          (row.original.maxUses === 1 && row.original.bypassCurfew);
        return (
          <div className="flex items-center gap-1.5 text-sm">
            <Icon className="size-4 text-muted-foreground" />
            <span>{m.label}</span>
            {isNightPass ? (
              <Badge variant="secondary" className="text-[10px]">
                🌙 Pase nocturno · {row.original.usesCount}/1
              </Badge>
            ) : (
              row.original.bypassCurfew && (
                <Badge variant="outline" className="text-[10px]">
                  24 h
                </Badge>
              )
            )}
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
        if (!canManage) return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Acciones">
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
      <ExtraAccessSettingsCard />
      <NightPassSettingsCard />
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
          canManage ? (
            <div className="flex gap-2">
              {hasFacial && (
                <Button variant="outline" onClick={() => setFacialOpen(true)}>
                  <ScanFace className="mr-1 h-4 w-4" /> Añadir facial
                </Button>
              )}
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> Nueva credencial
              </Button>
            </div>
          ) : null
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

      {facialOpen && <FacialCredentialDialog onClose={() => setFacialOpen(false)} />}

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
      allowedHours: { windows: [] },
      bypassCurfew: false,
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
        allowedHours: values.allowedHours ?? { windows: [] },
        bypassCurfew: values.bypassCurfew ?? false,
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
                      {(Object.keys(METHOD_LABELS) as AccessMethodValue[])
                        .filter((m) => m !== 'face')
                        .map((m) => (
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
            <FormField
              control={form.control}
              name="bypassCurfew"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value ?? false}
                      onCheckedChange={(v) => field.onChange(v === true)}
                    />
                  </FormControl>
                  <FormLabel className="!mt-0">
                    Acceso 24h (salta el toque de queda del local) — staff
                  </FormLabel>
                </FormItem>
              )}
            />
            <Controller
              control={form.control}
              name="allowedHours"
              render={({ field }) => (
                <div className="space-y-1">
                  <FormLabel>Ventanas horarias de acceso</FormLabel>
                  <AccessWindowsEditor
                    windows={field.value?.windows ?? []}
                    onChange={(windows) => field.onChange({ windows })}
                  />
                </div>
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
// Facial credential (add-on)
// ============================================================================

function FacialCredentialDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateFacialCredential();
  const customers = useCustomers();
  const [customerId, setCustomerId] = useState('');
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ base64: string; mime: 'image/jpeg' | 'image/png' } | null>(
    null,
  );
  const [fileError, setFileError] = useState<string | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
      setFileError('La foto debe ser JPEG o PNG.');
      return;
    }
    // Dahua FaceInfoManager limita la foto a ~100 KB.
    if (file.size > 100_000) {
      setFileError('La foto no puede superar los 100 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.split(',')[1] ?? '';
      setPhoto({ base64, mime: file.type as 'image/jpeg' | 'image/png' });
      setPreview(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    if (!customerId || !photo) return;
    try {
      await create.mutateAsync({
        customerId,
        ...(label.trim() ? { label: label.trim() } : {}),
        photoBase64: photo.base64,
        photoMimeType: photo.mime,
      });
      toast.success('Credencial facial creada. Se sincronizará con el terminal.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Acceso por reconocimiento facial</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            «Tu cara es la llave»: sube una foto del rostro del inquilino. El terminal la usa para
            validar el acceso sin PIN ni tarjeta.
          </p>
          <div className="space-y-1.5">
            <Label>Inquilino</Label>
            <Select onValueChange={setCustomerId} value={customerId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecciona inquilino" />
              </SelectTrigger>
              <SelectContent>
                {(customers.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Etiqueta (opcional)</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ej: Rostro principal"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Foto del rostro (JPEG/PNG, máx. 100 KB)</Label>
            <Input type="file" accept="image/jpeg,image/png" onChange={onFile} />
            {fileError && <p className="text-sm text-destructive">{fileError}</p>}
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt="Vista previa del rostro"
                className="mt-2 h-32 w-32 rounded-md border object-cover"
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!customerId || !photo || create.isPending}
          >
            {create.isPending ? 'Creando...' : 'Crear credencial facial'}
          </Button>
        </DialogFooter>
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
          <div className="rounded-md border bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Guarda este código ahora. <strong>No se mostrará otra vez.</strong>
          </div>
          {credential.revealedSecret ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 font-mono text-lg">
              <span className="flex-1 break-all">{credential.revealedSecret}</span>
              <Button type="button" size="icon" variant="ghost" onClick={copy} aria-label="Copiar">
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

/**
 * Ajuste del tenant: máximo de accesos adicionales que un inquilino puede
 * crearse desde su portal (p. ej. para familiares). Solo owner/manager.
 */
function ExtraAccessSettingsCard() {
  const canManage = useHasPermission('settings:manage');
  const settings = useAccessSettings();
  const update = useUpdateAccessSettings();
  const [value, setValue] = useState<string>('');

  if (!canManage) return null;

  const current = settings.data?.extraAccessLimit ?? 0;
  const parsed = value === '' ? current : Number(value);
  const dirty = value !== '' && Number(value) !== current;

  async function save() {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      toast.error('Indica un número entre 0 y 10.');
      return;
    }
    try {
      await update.mutateAsync({ extraAccessLimit: n });
      setValue('');
      toast.success('Límite de accesos actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Accesos adicionales del inquilino</CardTitle>
        <CardDescription>
          Cuántos accesos extra (para familiares, empleados…) puede crearse cada inquilino desde su
          portal, además del que recibe al contratar. 0 = desactivado.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="extra-access-limit" className="text-xs">
              Máximo por inquilino
            </Label>
            <Input
              id="extra-access-limit"
              type="number"
              min={0}
              max={10}
              className="h-9 w-24"
              value={value === '' ? String(current) : value}
              onChange={(e) => setValue(e.target.value)}
              disabled={settings.isLoading}
            />
          </div>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || update.isPending}>
            Guardar
          </Button>
          <span className="pb-2 text-xs text-muted-foreground">Actual: {parsed}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Pase nocturno: el inquilino compra un código de un solo uso (de pago). */
function NightPassSettingsCard() {
  const canManage = useHasPermission('settings:manage');
  const settings = useAccessSettings();
  const update = useUpdateAccessSettings();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [price, setPrice] = useState<string>('');

  if (!canManage) return null;

  const curEnabled = enabled ?? settings.data?.nightPassEnabled ?? false;
  const curPrice = price === '' ? (settings.data?.nightPassPrice ?? 0) : Number(price);

  async function save() {
    try {
      await update.mutateAsync({ nightPassEnabled: curEnabled, nightPassPrice: curPrice });
      setEnabled(null);
      setPrice('');
      toast.success('Pase nocturno actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pase nocturno (de pago)</CardTitle>
        <CardDescription>
          Permite al inquilino comprar desde su portal un código de <strong>un solo uso</strong> que
          salta el toque de queda y caduca a la mañana siguiente. Se le factura el importe (+ IVA).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={curEnabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-4"
            />
            Activar
          </label>
          <div className="space-y-1">
            <Label htmlFor="night-pass-price" className="text-xs">
              Precio (€, sin IVA)
            </Label>
            <Input
              id="night-pass-price"
              type="number"
              step="0.01"
              min={0}
              className="h-9 w-28"
              value={price === '' ? String(settings.data?.nightPassPrice ?? 0) : price}
              onChange={(e) => setPrice(e.target.value)}
              disabled={settings.isLoading}
            />
          </div>
          <Button size="sm" onClick={() => void save()} disabled={update.isPending}>
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const WEEK_DAYS: { v: number; l: string }[] = [
  { v: 1, l: 'L' },
  { v: 2, l: 'M' },
  { v: 3, l: 'X' },
  { v: 4, l: 'J' },
  { v: 5, l: 'V' },
  { v: 6, l: 'S' },
  { v: 0, l: 'D' },
];

/**
 * Editor de ventanas horarias de una credencial: cada franja son unos días de
 * la semana + un rango [inicio, fin) (sin cruzar medianoche). Sin franjas =
 * acceso a cualquier hora (sujeto al toque de queda del local).
 */
function AccessWindowsEditor({
  windows,
  onChange,
}: {
  windows: AccessWindow[];
  onChange: (windows: AccessWindow[]) => void;
}) {
  const update = (i: number, patch: Partial<AccessWindow>) =>
    onChange(windows.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  const toggleDay = (i: number, day: number) => {
    const w = windows[i]!;
    const days = w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day];
    update(i, { days });
  };

  return (
    <div className="space-y-2">
      {windows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Sin restricción: acceso a cualquier hora (sujeto al toque de queda del local).
        </p>
      )}
      {windows.map((w, i) => (
        <div key={i} className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap gap-1">
            {WEEK_DAYS.map((d) => (
              <button
                key={d.v}
                type="button"
                onClick={() => toggleDay(i, d.v)}
                className={`flex size-7 items-center justify-center rounded-full text-xs font-medium ${
                  w.days.includes(d.v)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {d.l}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={w.start}
              onChange={(e) => update(i, { start: e.target.value })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
            <span className="text-sm text-muted-foreground">a</span>
            <input
              type="time"
              value={w.end}
              onChange={(e) => update(i, { end: e.target.value })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto size-8"
              aria-label="Eliminar franja"
              onClick={() => onChange(windows.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...windows, { days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' }])
        }
      >
        <Plus className="mr-1 size-4" /> Añadir franja horaria
      </Button>
    </div>
  );
}
