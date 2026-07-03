'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { SaasAddonDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAddonSuspension,
  useAdminAddons,
  useAssignAddon,
  useRemoveAddon,
  useTenantBillingSummary,
  useTenantLimits,
} from '@/lib/admin/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export function TenantAddonsCard({ tenantId }: { tenantId: string }) {
  const summary = useTenantBillingSummary(tenantId);
  const limits = useTenantLimits(tenantId);
  const catalog = useAdminAddons();
  const assign = useAssignAddon(tenantId);
  const remove = useRemoveAddon(tenantId);
  const suspend = useAddonSuspension(tenantId, 'suspend');
  const reactivate = useAddonSuspension(tenantId, 'reactivate');
  const [selected, setSelected] = useState<string>('');

  async function doSuspend(id: string) {
    try {
      await suspend.mutateAsync(id);
      toast.success('Add-on suspendido. Su funcionalidad queda desactivada.');
    } catch {
      toast.error('No se pudo suspender.');
    }
  }
  async function doReactivate(id: string) {
    try {
      await reactivate.mutateAsync(id);
      toast.success('Add-on reactivado.');
    } catch {
      toast.error('No se pudo reactivar.');
    }
  }

  const assigned = summary.data?.addons ?? [];
  const assignedIds = new Set(assigned.map((a) => a.addonId));
  const available = (catalog.data ?? []).filter(
    (a: SaasAddonDto) => a.isActive && !assignedIds.has(a.id),
  );

  async function doAssign() {
    if (!selected) return;
    try {
      await assign.mutateAsync({ addonId: selected, quantity: 1 });
      toast.success('Add-on añadido. Si tiene feature, se activó en el tenant.');
      setSelected('');
    } catch {
      toast.error('No se pudo añadir.');
    }
  }

  async function doRemove(id: string) {
    try {
      await remove.mutateAsync(id);
      toast.success('Add-on retirado.');
    } catch {
      toast.error('No se pudo retirar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add-ons facturables</CardTitle>
        <CardDescription>
          Extras recurrentes sobre la suscripción. Asignar uno con feature la activa en el tenant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            {assigned.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin add-ons contratados.</p>
            ) : (
              <div className="space-y-2">
                {assigned.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                  >
                    <div>
                      <span
                        className={
                          a.suspended ? 'font-medium line-through opacity-60' : 'font-medium'
                        }
                      >
                        {a.name}
                      </span>
                      {a.quantity > 1 && (
                        <span className="ml-1 text-muted-foreground">×{a.quantity}</span>
                      )}
                      {a.feature && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          {a.feature}
                        </Badge>
                      )}
                      {a.suspended && (
                        <Badge className="ml-2 bg-amber-500 text-[10px] text-white hover:bg-amber-500">
                          Suspendido
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          a.suspended ? 'text-muted-foreground line-through' : 'font-semibold'
                        }
                      >
                        {eur(a.lineTotal)}/mes
                      </span>
                      {a.suspended ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => doReactivate(a.id)}
                          disabled={reactivate.isPending}
                        >
                          Reactivar
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-amber-600 hover:text-amber-700"
                          onClick={() => doSuspend(a.id)}
                          disabled={suspend.isPending}
                        >
                          Suspender
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-red-600"
                        aria-label="Quitar"
                        onClick={() => doRemove(a.id)}
                        disabled={remove.isPending}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Total efectivo */}
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Plan {summary.data?.planName ?? ''}</span>
                <span>{eur(summary.data?.planMonthly ?? 0)}/mes</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Add-ons</span>
                <span>{eur(summary.data?.addonsMonthly ?? 0)}/mes</span>
              </div>
              <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
                <span>Total efectivo</span>
                <span>{eur(summary.data?.effectiveMonthly ?? 0)}/mes</span>
              </div>
            </div>

            {/* Uso vs límite (plan + add-ons de capacidad) */}
            {limits.data && (
              <div className="flex flex-wrap gap-2 text-xs">
                {(
                  [
                    ['Trasteros', limits.data.units],
                    ['Locales', limits.data.facilities],
                    ['Usuarios', limits.data.users],
                  ] as const
                ).map(([label, l]) => {
                  const atLimit = l.limit !== null && l.used >= l.limit;
                  return (
                    <span
                      key={label}
                      className={`rounded-md border px-2 py-1 ${atLimit ? 'border-amber-400 text-amber-600 dark:text-amber-400' : ''}`}
                    >
                      {label}: {l.used}
                      {l.limit === null ? ' / ∞' : ` / ${l.limit}`}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Añadir */}
            {available.length > 0 && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Select value={selected} onValueChange={setSelected}>
                    <SelectTrigger>
                      <SelectValue placeholder="Añadir add-on…" />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name} · {eur(a.priceMonthly)}/mes
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={doAssign} disabled={!selected || assign.isPending}>
                  <Plus className="mr-1 size-4" /> Añadir
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
