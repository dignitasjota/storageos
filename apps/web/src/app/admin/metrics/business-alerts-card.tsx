'use client';

import { AlertTriangle, CheckCircle2, Loader2, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminBusinessAlertSettingsDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBusinessAlerts, useUpdateBusinessAlertSettings } from '@/lib/admin/business-hooks';
import { ApiError } from '@/lib/auth/api';

/** Avisos de negocio de ahora mismo (los mismos que van en el resumen semanal). */
export function BusinessAlertsCard() {
  const q = useBusinessAlerts();
  const [editing, setEditing] = useState(false);
  const d = q.data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div>
          <CardTitle className="text-base">Avisos de negocio</CardTitle>
          <p className="text-xs text-muted-foreground">
            Caída del MRR, churn alto, tenants grandes en riesgo y gasto de IA. Van también en el
            resumen semanal por correo y por Telegram o Slack.
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Umbrales de los avisos"
          title="Umbrales de los avisos"
          onClick={() => setEditing((v) => !v)}
          disabled={!d}
        >
          <Settings2 className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading || !d ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {editing && (
              <AlertSettingsForm settings={d.settings} onDone={() => setEditing(false)} />
            )}
            {!d.settings.enabled ? (
              <p className="text-sm text-muted-foreground">Los avisos de negocio están apagados.</p>
            ) : d.alerts.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-green-600" /> Nada que vigilar ahora mismo.
              </p>
            ) : (
              <ul className="space-y-2">
                {d.alerts.map((a, i) => (
                  <li key={`${a.kind}-${a.tenantId ?? i}`} className="flex gap-2 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <div>
                      {a.tenantId ? (
                        <Link
                          href={`/admin/tenants/${a.tenantId}?tab=business`}
                          className="font-medium hover:underline"
                        >
                          {a.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{a.title}</span>
                      )}
                      <p className="text-xs text-muted-foreground">{a.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AlertSettingsForm({
  settings,
  onDone,
}: {
  settings: AdminBusinessAlertSettingsDto;
  onDone: () => void;
}) {
  const update = useUpdateBusinessAlertSettings();
  const [form, setForm] = useState({
    enabled: settings.enabled,
    mrrDropPct: String(settings.mrrDropPct),
    churnPct: String(settings.churnPct),
    aiCostUsdWeek: String(settings.aiCostUsdWeek),
    bigTenantMrr: String(settings.bigTenantMrr),
  });
  const n = (v: string) => Number(v.replace(',', '.'));

  async function save() {
    try {
      await update.mutateAsync({
        enabled: form.enabled,
        mrrDropPct: n(form.mrrDropPct),
        churnPct: n(form.churnPct),
        aiCostUsdWeek: n(form.aiCostUsdWeek),
        bigTenantMrr: n(form.bigTenantMrr),
      });
      toast.success('Umbrales guardados.');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron guardar.');
    }
  }

  const field = (key: keyof Omit<typeof form, 'enabled'>, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`ba-${key}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`ba-${key}`}
        inputMode="decimal"
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={form.enabled}
          onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v === true }))}
        />
        Avisos de negocio activados
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {field('mrrDropPct', 'Caída del MRR frente al mes pasado (%)')}
        {field('churnPct', 'Churn del mes (%)')}
        {field('bigTenantMrr', 'Tenant grande desde (€/mes)')}
        {field('aiCostUsdWeek', 'Gasto de IA de un tenant en 7 días ($)')}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          Cancelar
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={update.isPending}>
          Guardar
        </Button>
      </div>
    </div>
  );
}
