'use client';

import {
  FEATURE_LABELS,
  resolvePlanFeatures,
  TenantFeatures,
  UpsertSubscriptionPlanSchema,
  type SubscriptionPlanDto,
  type TenantFeature,
  type UpsertSubscriptionPlanFormInput,
} from '@storageos/shared';
import { Ban, Check, History, Loader2, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { PriceHistoryList } from '@/components/admin/price-history-list';
import { useConfirm } from '@/components/confirm-provider';
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
  useCatalogPriceHistory,
  useCreatePlan,
  useDeactivatePlan,
  usePlanPricePreview,
  useUpdatePlan,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type FormState = {
  slug: string;
  name: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  stripePriceId: string;
  stripePriceIdYearly: string;
  maxUnits: string;
  maxFacilities: string;
  maxUsers: string;
  tenantFeatures: TenantFeature[];
  isActive: boolean;
  isPublic: boolean;
};

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const emptyForm: FormState = {
  slug: '',
  name: '',
  description: '',
  priceMonthly: 0,
  priceYearly: 0,
  stripePriceId: '',
  stripePriceIdYearly: '',
  maxUnits: '',
  maxFacilities: '',
  maxUsers: '',
  tenantFeatures: [],
  isActive: true,
  isPublic: true,
};

function toForm(p: SubscriptionPlanDto): FormState {
  return {
    slug: p.slug,
    name: p.name,
    description: p.description ?? '',
    priceMonthly: p.priceMonthly,
    priceYearly: p.priceYearly,
    stripePriceId: p.stripePriceId ?? '',
    stripePriceIdYearly: p.stripePriceIdYearly ?? '',
    maxUnits: p.maxUnits?.toString() ?? '',
    maxFacilities: p.maxFacilities?.toString() ?? '',
    maxUsers: p.maxUsers?.toString() ?? '',
    tenantFeatures: p.tenantFeatures,
    isActive: p.isActive,
    isPublic: p.isPublic,
  };
}

export default function PlansPage() {
  const confirm = useConfirm();
  const { data, isLoading } = useAdminAllPlans();
  const create = useCreatePlan();
  const update = useUpdatePlan();
  const deactivate = useDeactivatePlan();
  const [editing, setEditing] = useState<SubscriptionPlanDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [historyOf, setHistoryOf] = useState<SubscriptionPlanDto | null>(null);
  const priceChanged = !!editing && form.priceMonthly !== editing.priceMonthly;
  const preview = usePlanPricePreview(
    priceChanged ? (editing?.id ?? null) : null,
    priceChanged ? form.priceMonthly : null,
  );

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
      stripePriceId: form.stripePriceId.trim() || null,
      stripePriceIdYearly: form.stripePriceIdYearly.trim() || null,
      currency: 'EUR',
      // Conserva lo que ya tuviera el plan (no se edita aquí).
      features: editing?.features ?? {},
      tenantFeatures: form.tenantFeatures,
      maxUnits: form.maxUnits ? Number(form.maxUnits) : null,
      maxFacilities: form.maxFacilities ? Number(form.maxFacilities) : null,
      maxUsers: form.maxUsers ? Number(form.maxUsers) : null,
      isActive: form.isActive,
      isPublic: form.isPublic,
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
    if (!(await confirm({ title: `¿Desactivar el plan «${p.name}»?`, destructive: true }))) return;
    try {
      await deactivate.mutateAsync(p.id);
      toast.success('Plan desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Planes</h1>
          <p className="text-sm text-muted-foreground">
            Precios, límites y features premium de cada plan de suscripción.
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
                  <TableHead>Tenants</TableHead>
                  <TableHead>MRR</TableHead>
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
                      {p.tenantCount ? (
                        <Link
                          href={`/admin/tenants?plan=${encodeURIComponent(p.slug)}`}
                          className="hover:underline"
                          title={`${p.payingTenants ?? 0} pagan`}
                        >
                          {p.tenantCount}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{eur(p.mrr ?? 0)}</TableCell>
                    <TableCell className="space-x-1">
                      {p.isActive ? (
                        <Badge variant="outline" className="text-emerald-600">
                          activo
                        </Badge>
                      ) : (
                        <Badge variant="secondary">inactivo</Badge>
                      )}
                      {!p.isPublic && (
                        <Badge variant="outline" title="No sale en la web ni en el autoservicio">
                          oculto
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="space-x-2 whitespace-nowrap text-right">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="Editar"
                        title="Editar"
                        onClick={() => openEdit(p)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Historial de precios"
                        title="Historial de precios"
                        onClick={() => setHistoryOf(p)}
                      >
                        <History className="size-4" />
                      </Button>
                      {p.isActive && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Desactivar"
                          title={
                            p.tenantCount
                              ? `Tiene ${p.tenantCount} tenants: pásalos antes a otro plan`
                              : 'Desactivar'
                          }
                          disabled={!!p.tenantCount}
                          onClick={() => onDeactivate(p)}
                        >
                          <Ban className="size-4" />
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

      <FeatureMatrix plans={(data ?? []).filter((p) => p.isActive)} />

      <PriceHistoryDialog plan={historyOf} onClose={() => setHistoryOf(null)} />

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar plan' : 'Nuevo plan'}</DialogTitle>
            <DialogDescription>
              Define precio, límites y las features premium incluidas en el plan.
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
            {priceChanged && preview.data && (
              <div className="col-span-2 rounded-md border bg-muted/40 p-2 text-xs">
                {preview.data.payingTenants === 0 ? (
                  'Ningún tenant paga este plan ahora: el cambio no afecta al MRR.'
                ) : (
                  <>
                    {preview.data.payingTenants}{' '}
                    {preview.data.payingTenants === 1 ? 'tenant paga' : 'tenants pagan'} este plan.
                    MRR {eur(preview.data.currentMrr)} → {eur(preview.data.newMrr)} (
                    {preview.data.delta >= 0 ? '+' : ''}
                    {eur(preview.data.delta)}).
                    {preview.data.stripeTenants > 0 &&
                      ` ${preview.data.stripeTenants} pagan por Stripe: siguen con el precio antiguo hasta que cambies el Price en Stripe.`}
                  </>
                )}
              </div>
            )}
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
            <div className="space-y-1 sm:col-span-2">
              <Label>Stripe Price ID (mensual)</Label>
              <Input
                value={form.stripePriceId}
                onChange={(e) => setForm((f) => ({ ...f, stripePriceId: e.target.value }))}
                placeholder="price_..."
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Stripe Price ID (anual)</Label>
              <Input
                value={form.stripePriceIdYearly}
                onChange={(e) => setForm((f) => ({ ...f, stripePriceIdYearly: e.target.value }))}
                placeholder="price_... (opcional, habilita el pago anual)"
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
            <div className="col-span-2 space-y-1.5">
              <Label>Features premium incluidas</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {TenantFeatures.map((feat) => {
                  const checked = form.tenantFeatures.includes(feat);
                  return (
                    <label key={feat} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            tenantFeatures: e.target.checked
                              ? [...f.tenantFeatures, feat]
                              : f.tenantFeatures.filter((x) => x !== feat),
                          }))
                        }
                      />
                      {FEATURE_LABELS[feat]}
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Los tenants con este plan verán estos módulos. Un plan sin ninguna marcada no
                incluye funciones premium.
              </p>
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              Activo
            </label>
            <label className="col-span-2 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.isPublic}
                onChange={(e) => setForm((f) => ({ ...f, isPublic: e.target.checked }))}
              />
              <span>
                Visible en la web y en el autoservicio
                <span className="block text-xs text-muted-foreground">
                  Sin marcar, el plan queda oculto: solo lo asignas tú (planes negociados).
                </span>
              </span>
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

/** Qué funciones premium incluye cada plan activo. */
function FeatureMatrix({ plans }: { plans: SubscriptionPlanDto[] }) {
  if (plans.length === 0) return null;
  const byPlan = new Map(plans.map((p) => [p.id, new Set(resolvePlanFeatures(p))]));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Funciones por plan</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">Función</th>
              {plans.map((p) => (
                <th key={p.id} className="px-2 py-1 text-center font-normal">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TenantFeatures.map((f) => (
              <tr key={f} className="border-t">
                <td className="py-1 pr-3">{FEATURE_LABELS[f]}</td>
                {plans.map((p) => (
                  <td key={p.id} className="px-2 py-1 text-center">
                    {byPlan.get(p.id)?.has(f) ? (
                      <Check className="mx-auto size-4 text-emerald-600" aria-label="Incluida" />
                    ) : (
                      <span className="text-muted-foreground" aria-label="No incluida">
                        —
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Las que no marca ningún plan solo se venden como extra.
        </p>
      </CardContent>
    </Card>
  );
}

function PriceHistoryDialog({
  plan,
  onClose,
}: {
  plan: SubscriptionPlanDto | null;
  onClose: () => void;
}) {
  const history = useCatalogPriceHistory('plan', plan?.id ?? null);
  return (
    <Dialog open={!!plan} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Historial de precios · {plan?.name}</DialogTitle>
        </DialogHeader>
        <PriceHistoryList loading={history.isLoading} rows={history.data ?? []} withYearly />
      </DialogContent>
    </Dialog>
  );
}
