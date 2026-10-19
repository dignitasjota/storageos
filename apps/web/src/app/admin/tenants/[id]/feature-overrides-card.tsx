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
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');
/** `YYYY-MM-DD` del último día de una cortesía (caduca al empezar el día siguiente). */
function lastDay(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
}

/**
 * Funciones premium del tenant: las del plan, las que da un extra contratado o
 * en prueba (se gestionan desde «Add-ons») y las cortesías del super admin,
 * que pueden llevar fecha de fin.
 */
export function FeatureOverridesCard({ tenantId }: { tenantId: string }) {
  const canEdit = useIsSuperadmin();
  const { data } = useAdminTenantFeatures(tenantId);
  const save = useSetTenantFeatures(tenantId);
  // Estado deseado por feature (checked = activa) y fin de la cortesía.
  const [state, setState] = useState<Record<string, boolean>>({});
  const [until, setUntil] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) {
      const next: Record<string, boolean> = {};
      const dates: Record<string, string> = {};
      for (const f of TenantFeatures) next[f] = data.effective.includes(f);
      for (const o of data.overrides) {
        if (o.source === 'manual' && o.expiresAt) dates[o.feature] = lastDay(o.expiresAt);
      }
      setState(next);
      setUntil(dates);
    }
  }, [data]);

  if (!data) return null;

  const planSet = new Set(data.planFeatures);
  const managed = new Map(
    data.overrides.filter((o) => o.source !== 'manual').map((o) => [o.feature, o]),
  );
  const savedUntil: Record<string, string> = {};
  for (const o of data.overrides) {
    if (o.source === 'manual' && o.expiresAt) savedUntil[o.feature] = lastDay(o.expiresAt);
  }
  const dirty =
    TenantFeatures.some((f) => (state[f] ?? false) !== data.effective.includes(f)) ||
    TenantFeatures.some((f) => (until[f] ?? '') !== (savedUntil[f] ?? ''));

  async function onSave() {
    // Override = feature cuyo estado deseado difiere del plan (sin las de extras).
    const overrides = TenantFeatures.filter(
      (f) => !managed.has(f as TenantFeature) && (state[f] ?? false) !== planSet.has(f),
    ).map((f) => ({
      feature: f as TenantFeature,
      enabled: state[f] ?? false,
      expiresAt: state[f] && until[f] ? until[f] : null,
    }));
    try {
      await save.mutateAsync(overrides);
      toast.success('Funciones actualizadas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Funciones premium</CardTitle>
        <CardDescription>
          Activa o desactiva funciones sin cambiarle el plan (cortesía, beta…), con fecha de fin si
          quieres. El plan «{data.planSlug ?? '—'}» marca el valor por defecto; las de un extra se
          gestionan en «Add-ons».
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {TenantFeatures.map((f) => {
            const inPlan = planSet.has(f);
            const checked = state[f] ?? false;
            const m = managed.get(f as TenantFeature);
            const isCourtesy = !m && checked !== inPlan;
            return (
              <li key={f} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                  {FEATURE_LABELS[f]}
                  {inPlan && (
                    <Badge variant="outline" className="text-[10px]">
                      en plan
                    </Badge>
                  )}
                  {m?.source === 'addon' && (
                    <Badge variant="secondary" className="text-[10px]">
                      extra contratado
                    </Badge>
                  )}
                  {m?.source === 'trial' && (
                    <Badge className="bg-amber-500 text-[10px] text-white hover:bg-amber-500">
                      prueba hasta {m.expiresAt ? day(m.expiresAt) : '—'}
                    </Badge>
                  )}
                  {isCourtesy && (
                    <Badge variant="secondary" className="text-[10px]">
                      {checked ? 'cortesía' : 'quitada'}
                    </Badge>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {isCourtesy && checked && (
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      hasta
                      <input
                        type="date"
                        value={until[f] ?? ''}
                        min={new Date().toLocaleDateString('sv-SE')}
                        onChange={(e) => setUntil((u) => ({ ...u, [f]: e.target.value }))}
                        className="h-7 rounded border bg-background px-1 text-xs"
                        aria-label={`Fin de la cortesía de ${FEATURE_LABELS[f]}`}
                      />
                    </label>
                  )}
                  <Checkbox
                    checked={checked}
                    disabled={!!m}
                    onCheckedChange={(v) => setState((s) => ({ ...s, [f]: v === true }))}
                  />
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Sin fecha, la cortesía no caduca.</p>
          <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending || !canEdit}>
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
