'use client';

import {
  UpsertSubscriptionPlanSchema,
  type SubscriptionPlanDto,
  type UpsertSubscriptionPlanFormInput,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useAdminAllPlans,
  useCreatePlan,
  useDeactivatePlan,
  useUpdatePlan,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type FormState = {
  slug: string;
  name: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  maxUnits: string;
  maxFacilities: string;
  maxUsers: string;
  isActive: boolean;
};

const emptyForm: FormState = {
  slug: '',
  name: '',
  description: '',
  priceMonthly: 0,
  priceYearly: 0,
  maxUnits: '',
  maxFacilities: '',
  maxUsers: '',
  isActive: true,
};

function toForm(p: SubscriptionPlanDto): FormState {
  return {
    slug: p.slug,
    name: p.name,
    description: p.description ?? '',
    priceMonthly: p.priceMonthly,
    priceYearly: p.priceYearly,
    maxUnits: p.maxUnits?.toString() ?? '',
    maxFacilities: p.maxFacilities?.toString() ?? '',
    maxUsers: p.maxUsers?.toString() ?? '',
    isActive: p.isActive,
  };
}

export default function PlansPage() {
  const { data, isLoading } = useAdminAllPlans();
  const create = useCreatePlan();
  const update = useUpdatePlan();
  const deactivate = useDeactivatePlan();
  const [editing, setEditing] = useState<SubscriptionPlanDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  function openCreate() {
    setForm(emptyForm);
    setEditing(null);
    setCreating(true);
  }
  function openEdit(p: SubscriptionPlanDto) {
    setForm(toForm(p));
    setEditing(p);
    setCreating(true);
  }

  function buildInput(): UpsertSubscriptionPlanFormInput | null {
    const parsed = UpsertSubscriptionPlanSchema.safeParse({
      slug: form.slug,
      name: form.name,
      description: form.description || null,
      priceMonthly: form.priceMonthly,
      priceYearly: form.priceYearly,
      currency: 'EUR',
      features: {},
      maxUnits: form.maxUnits ? Number(form.maxUnits) : null,
      maxFacilities: form.maxFacilities ? Number(form.maxFacilities) : null,
      maxUsers: form.maxUsers ? Number(form.maxUsers) : null,
      isActive: form.isActive,
    });
    if (!parsed.success) {
      toast.error('Revisa los datos (slug en minúsculas, precios válidos).');
      return null;
    }
    return parsed.data;
  }

  async function onSubmit() {
    const input = buildInput();
    if (!input) return;
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, input });
        toast.success('Plan actualizado.');
      } else {
        await create.mutateAsync(input);
        toast.success('Plan creado.');
      }
      setCreating(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onDeactivate(p: SubscriptionPlanDto) {
    if (!window.confirm(`¿Desactivar el plan «${p.name}»?`)) return;
    try {
      await deactivate.mutateAsync(p.id);
      toast.success('Plan desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Planes</h1>
          <p className="text-sm text-muted-foreground">
            Precios y límites de los planes de suscripción. Las features incluidas por plan se
            definen en código (por slug).
          </p>
        </div>
        <Button onClick={openCreate}>Nuevo plan</Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Catálogo</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>€/mes</TableHead>
                  <TableHead>€/año</TableHead>
                  <TableHead>Límites (loc/tra/usr)</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs">{p.slug}</TableCell>
                    <TableCell>{p.priceMonthly} €</TableCell>
                    <TableCell>{p.priceYearly} €</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.maxFacilities ?? '∞'} / {p.maxUnits ?? '∞'} / {p.maxUsers ?? '∞'}
                    </TableCell>
                    <TableCell>
                      {p.isActive ? (
                        <Badge variant="outline" className="text-emerald-600">
                          activo
                        </Badge>
                      ) : (
                        <Badge variant="secondary">inactivo</Badge>
                      )}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                        Editar
                      </Button>
                      {p.isActive && (
                        <Button variant="ghost" size="sm" onClick={() => onDeactivate(p)}>
                          Desactivar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar plan' : 'Nuevo plan'}</DialogTitle>
            <DialogDescription>
              Las features por plan se gestionan en código; aquí defines precio y límites.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Slug</Label>
              <Input
                value={form.slug}
                disabled={Boolean(editing)}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>Descripción</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Precio mensual (€)</Label>
              <Input
                type="number"
                value={form.priceMonthly}
                onChange={(e) =>
                  setForm((f) => ({ ...f, priceMonthly: e.target.valueAsNumber || 0 }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Precio anual (€)</Label>
              <Input
                type="number"
                value={form.priceYearly}
                onChange={(e) =>
                  setForm((f) => ({ ...f, priceYearly: e.target.valueAsNumber || 0 }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Máx. locales (vacío = ∞)</Label>
              <Input
                value={form.maxFacilities}
                onChange={(e) => setForm((f) => ({ ...f, maxFacilities: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Máx. trasteros</Label>
              <Input
                value={form.maxUnits}
                onChange={(e) => setForm((f) => ({ ...f, maxUnits: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Máx. usuarios</Label>
              <Input
                value={form.maxUsers}
                onChange={(e) => setForm((f) => ({ ...f, maxUsers: e.target.value }))}
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              Activo
            </label>
          </div>
          <DialogFooter>
            <Button onClick={onSubmit} disabled={create.isPending || update.isPending}>
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
