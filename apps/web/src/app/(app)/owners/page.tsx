'use client';

import { Loader2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { OwnerDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCreateOwner,
  useOwnerCertificate,
  useOwners,
  useRemoveOwnerCertificate,
  useUpdateOwner,
  useUploadOwnerCertificate,
} from '@/lib/owners/hooks';

export default function OwnersPage() {
  const owners = useOwners();
  const [editing, setEditing] = useState<OwnerDto | 'new' | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Propietarios</h1>
          <p className="text-sm text-muted-foreground">
            Los dueños de los locales que gestionas. Asigna cada local a su propietario en los
            ajustes del local; sus contratos y facturas quedan a su nombre.
          </p>
        </div>
        <Can permission="facilities:manage">
          <Button onClick={() => setEditing('new')}>
            <Plus className="mr-1 size-4" /> Nuevo propietario
          </Button>
        </Can>
      </div>

      {owners.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (owners.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Aún no hay propietarios.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(owners.data ?? []).map((o) => (
            <Card key={o.id}>
              <CardContent className="space-y-2 pt-6 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{o.legalName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{o.taxId}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!o.isActive && <Badge variant="secondary">Inactivo</Badge>}
                    <Can permission="facilities:manage">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Editar propietario"
                        title="Editar"
                        onClick={() => setEditing(o)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </Can>
                  </div>
                </div>
                <p className="text-muted-foreground">
                  {o.facilitiesCount} {o.facilitiesCount === 1 ? 'local' : 'locales'} · Honorarios:{' '}
                  {o.feeType === 'fixed'
                    ? `${o.feeValue.toFixed(2)} €/mes`
                    : `${o.feeValue} % de lo cobrado`}
                  {o.ibanLast4 && <> · Cuenta …{o.ibanLast4}</>}
                </p>
                <OwnerCertificateRow ownerId={o.id} />
                {(o.email || o.phone) && (
                  <p className="text-muted-foreground">
                    {[o.email, o.phone].filter(Boolean).join(' · ')}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <OwnerDialog owner={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function OwnerDialog({ owner, onClose }: { owner: OwnerDto | null; onClose: () => void }) {
  const create = useCreateOwner();
  const update = useUpdateOwner();
  const [form, setForm] = useState({
    legalName: owner?.legalName ?? '',
    taxId: owner?.taxId ?? '',
    address: owner?.address ?? '',
    city: owner?.city ?? '',
    postalCode: owner?.postalCode ?? '',
    email: owner?.email ?? '',
    phone: owner?.phone ?? '',
    iban: '',
    feeType: owner?.feeType ?? 'percentage',
    feeValue: String(owner?.feeValue ?? 0),
    isActive: owner?.isActive ?? true,
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const pending = create.isPending || update.isPending;

  async function save() {
    const input = {
      legalName: form.legalName,
      taxId: form.taxId,
      address: form.address,
      city: form.city,
      postalCode: form.postalCode,
      email: form.email,
      phone: form.phone,
      feeType: form.feeType,
      feeValue: Number(form.feeValue.replace(',', '.')) || 0,
      ...(form.iban.trim() ? { iban: form.iban } : {}),
    };
    try {
      if (owner)
        await update.mutateAsync({ id: owner.id, input: { ...input, isActive: form.isActive } });
      else await create.mutateAsync(input);
      toast.success('Propietario guardado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{owner ? 'Editar propietario' : 'Nuevo propietario'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="o-name">Nombre o razón social</Label>
            <Input id="o-name" value={form.legalName} onChange={set('legalName')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="o-tax">NIF / CIF</Label>
            <Input id="o-tax" value={form.taxId} onChange={set('taxId')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="o-phone">Teléfono</Label>
            <Input id="o-phone" value={form.phone} onChange={set('phone')} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="o-email">Email (para enviarle la liquidación)</Label>
            <Input id="o-email" type="email" value={form.email} onChange={set('email')} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="o-address">Domicilio fiscal</Label>
            <Input id="o-address" value={form.address} onChange={set('address')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="o-cp">Código postal</Label>
            <Input id="o-cp" value={form.postalCode} onChange={set('postalCode')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="o-city">Ciudad</Label>
            <Input id="o-city" value={form.city} onChange={set('city')} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="o-iban">
              IBAN para la liquidación
              {owner?.ibanLast4 && (
                <span className="text-muted-foreground"> (actual …{owner.ibanLast4})</span>
              )}
            </Label>
            <Input
              id="o-iban"
              value={form.iban}
              placeholder={owner?.ibanLast4 ? 'Déjalo vacío para conservarlo' : 'ES…'}
              onChange={set('iban')}
            />
          </div>
          <div className="space-y-1">
            <Label>Honorarios</Label>
            <Select
              value={form.feeType}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, feeType: v as 'percentage' | 'fixed' }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="percentage">% de lo cobrado</SelectItem>
                <SelectItem value="fixed">Cuota fija al mes</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="o-fee">{form.feeType === 'fixed' ? 'Importe (€)' : 'Porcentaje'}</Label>
            <Input
              id="o-fee"
              inputMode="decimal"
              value={form.feeValue}
              onChange={set('feeValue')}
            />
          </div>
          {owner && (
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              Activo
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={pending || !form.legalName || !form.taxId}>
            {pending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Certificado para Veri*Factu: el del propietario si lo sube; si no, sus
 * facturas se envían con el tuyo como su representante (debes estar
 * apoderado por él en la AEAT).
 */
function OwnerCertificateRow({ ownerId }: { ownerId: string }) {
  const canSee = useHasPermission('invoices:manage');
  const canEdit = useHasPermission('billing:configure');
  const cert = useOwnerCertificate(ownerId, canSee);
  const upload = useUploadOwnerCertificate(ownerId);
  const remove = useRemoveOwnerCertificate(ownerId);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  if (!canSee) return null;

  async function send() {
    if (!file) return;
    try {
      await upload.mutateAsync({ file, password, environment: 'production' });
      toast.success('Certificado guardado.');
      setOpen(false);
      setPassword('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir.');
    }
  }

  const c = cert.data;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {c
          ? `Certificado propio · ${c.certNif} · caduca ${new Date(c.certValidTo).toLocaleDateString('es-ES')}`
          : 'Veri*Factu: se envía con tu certificado como su representante'}
      </p>
      {canEdit && (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {c ? 'Cambiar' : 'Subir el suyo'}
          </Button>
          {c && (
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm('¿Quitar su certificado? Se usará el tuyo.')) {
                  remove.mutate();
                }
              }}
            >
              Quitar
            </Button>
          )}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Certificado del propietario</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`cert-${ownerId}`}>Fichero .p12 / .pfx</Label>
              <Input
                id={`cert-${ownerId}`}
                type="file"
                accept=".p12,.pfx,application/x-pkcs12"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`pass-${ownerId}`}>Contraseña del certificado</Label>
              <Input
                id={`pass-${ownerId}`}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void send()} disabled={!file || !password || upload.isPending}>
              {upload.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              Subir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
