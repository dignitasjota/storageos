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
import { useCreateOwner, useOwners, useUpdateOwner } from '@/lib/owners/hooks';

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
