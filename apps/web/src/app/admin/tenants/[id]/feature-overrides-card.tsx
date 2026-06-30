'use client';

import { FEATURE_LABELS, TenantFeatures } from '@storageos/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { TenantFeature } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { useAdminTenantFeatures, useSetTenantFeatures } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

export function FeatureOverridesCard({ tenantId }: { tenantId: string }) {
  const { data } = useAdminTenantFeatures(tenantId);
  const save = useSetTenantFeatures(tenantId);
  // Estado deseado por feature (checked = activa para el tenant).
  const [state, setState] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (data) {
      const next: Record<string, boolean> = {};
      for (const f of TenantFeatures) next[f] = data.effective.includes(f);
      setState(next);
    }
  }, [data]);

  if (!data) return null;

  const planSet = new Set(data.planFeatures);
  const dirty = TenantFeatures.some((f) => (state[f] ?? false) !== data.effective.includes(f));

  async function onSave() {
    // Override = feature cuyo estado deseado difiere del plan.
    const overrides = TenantFeatures.filter((f) => (state[f] ?? false) !== planSet.has(f)).map(
      (f) => ({ feature: f as TenantFeature, enabled: state[f] ?? false }),
    );
    try {
      await save.mutateAsync(overrides);
      toast.success('Features actualizadas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Features premium</CardTitle>
        <CardDescription>
          Activa o desactiva funciones para este tenant sin cambiarle el plan (cortesía, beta…). El
          plan «{data.planSlug ?? '—'}» marca el valor por defecto.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {TenantFeatures.map((f) => {
            const inPlan = planSet.has(f);
            const checked = state[f] ?? false;
            const isOverride = checked !== inPlan;
            return (
              <li key={f} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  {FEATURE_LABELS[f]}
                  {inPlan && (
                    <Badge variant="outline" className="text-[10px]">
                      en plan
                    </Badge>
                  )}
                  {isOverride && (
                    <Badge variant="secondary" className="text-[10px]">
                      override
                    </Badge>
                  )}
                </span>
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) => setState((s) => ({ ...s, [f]: v === true }))}
                />
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end">
          <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
