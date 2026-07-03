'use client';

import { FEATURE_LABELS, TenantFeatures, type SaasAddonDto } from '@storageos/shared';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { useAdminAddons, useUpsertAddon } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const NO_FEATURE = '__none__';

export default function AdminAddonsPage() {
  const addons = useAdminAddons();
  const [editing, setEditing] = useState<SaasAddonDto | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Add-ons facturables</h1>
          <p className="text-sm text-muted-foreground">
            Extras recurrentes que se asignan a los tenants (dominio propio, usuarios extra, IA…).
            Vincular una feature la activa al asignar el add-on.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1 size-4" /> Nuevo add-on
        </Button>
      </div>

      {addons.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-2">
          {(addons.data ?? []).map((a) => (
            <Card key={a.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-6">
                <div>
                  <span className="font-medium">{a.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{a.slug}</span>
                  {a.feature && (
                    <Badge variant="secondary" className="ml-2 text-[10px]">
                      {FEATURE_LABELS[a.feature as keyof typeof FEATURE_LABELS] ?? a.feature}
                    </Badge>
                  )}
                  {!a.isActive && (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      inactivo
                    </Badge>
                  )}
                  {a.description && (
                    <p className="text-xs text-muted-foreground">{a.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{eur(a.priceMonthly)}/mes</span>
                  <Button variant="ghost" size="icon" onClick={() => setEditing(a)}>
                    <Pencil className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
          {(addons.data ?? []).length === 0 && (
            <p className="rounded-md border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
              Aún no hay add-ons. Crea el primero.
            </p>
          )}
        </div>
      )}

      {(creating || editing) && (
        <AddonDialog
          addon={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function AddonDialog({ addon, onClose }: { addon: SaasAddonDto | null; onClose: () => void }) {
  const upsert = useUpsertAddon(addon?.id);
  const [slug, setSlug] = useState(addon?.slug ?? '');
  const [name, setName] = useState(addon?.name ?? '');
  const [description, setDescription] = useState(addon?.description ?? '');
  const [price, setPrice] = useState(String(addon?.priceMonthly ?? 0));
  const [feature, setFeature] = useState(addon?.feature ?? NO_FEATURE);
  const [isActive, setIsActive] = useState(addon?.isActive ?? true);

  async function save() {
    try {
      await upsert.mutateAsync({
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim(),
        priceMonthly: Number(price) || 0,
        feature: feature === NO_FEATURE ? '' : feature,
        isActive,
      });
      toast.success('Add-on guardado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{addon ? 'Editar add-on' : 'Nuevo add-on'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Nombre</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Slug</Label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="dominio-propio"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Descripción</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Precio mensual (€)</Label>
              <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Feature que activa</Label>
              <Select value={feature} onValueChange={setFeature}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FEATURE}>Ninguna (solo cobra)</SelectItem>
                  {TenantFeatures.map((f) => (
                    <SelectItem key={f} value={f}>
                      {FEATURE_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} /> Activo
            (asignable a tenants)
          </label>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={upsert.isPending || !name.trim() || !slug.trim()}>
            {upsert.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
