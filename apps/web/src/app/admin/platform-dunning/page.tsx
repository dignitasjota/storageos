'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAdminPlatformDunningSettings,
  useRunDunning,
  useUpdatePlatformDunningSettings,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type Form = {
  enabled: boolean;
  reminder1Days: number;
  reminder2Days: number;
  suspendDays: number;
};

export default function PlatformDunningPage() {
  const { data } = useAdminPlatformDunningSettings();
  const update = useUpdatePlatformDunningSettings();
  const run = useRunDunning();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (data && !form) setForm({ ...data });
  }, [data, form]);

  async function onSave() {
    if (!form) return;
    try {
      await update.mutateAsync(form);
      toast.success('Configuración del dunning guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  async function onRun() {
    try {
      const res = await run.mutateAsync();
      toast.success(
        `Evaluados ${res.evaluated} · ${res.reminders} recordatorios · ${res.suspended} suspensiones`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (!form) return null;
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dunning del SaaS</h1>
        <p className="text-sm text-muted-foreground">
          Cobro automático de tenants morosos: recordatorios escalados por email y suspensión
          automática tras N días de impago (suscripción en «pago fallido»).
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Configuración</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Dunning activado (el cron diario evalúa y actúa)
          </label>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>1.er recordatorio (días)</Label>
              <Input
                type="number"
                value={form.reminder1Days}
                onChange={(e) => set({ reminder1Days: e.target.valueAsNumber || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label>2.º recordatorio (días)</Label>
              <Input
                type="number"
                value={form.reminder2Days}
                onChange={(e) => set({ reminder2Days: e.target.valueAsNumber || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label>Suspender (días)</Label>
              <Input
                type="number"
                value={form.suspendDays}
                onChange={(e) => set({ suspendDays: e.target.valueAsNumber || 0 })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Días desde el vencimiento del periodo impagado. Deben ir en orden: 1.º ≤ 2.º ≤
            suspensión. Cada paso se ejecuta una sola vez por ciclo de impago.
          </p>
          <div className="flex justify-between">
            <Button variant="outline" onClick={onRun} disabled={run.isPending}>
              Ejecutar ahora
            </Button>
            <Button onClick={onSave} disabled={update.isPending}>
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
