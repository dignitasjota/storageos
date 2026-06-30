'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAdminPlatformAlerts,
  useRunPlatformAlerts,
  useUpdatePlatformAlerts,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

export default function PlatformAlertsPage() {
  const { data, isLoading } = useAdminPlatformAlerts();
  const update = useUpdatePlatformAlerts();
  const run = useRunPlatformAlerts();

  const [form, setForm] = useState({
    enabled: false,
    alertEmail: '',
    notifyPastDue: true,
    notifyTrialExpiring: true,
    trialExpiringDays: 3,
  });

  useEffect(() => {
    if (data) {
      setForm({
        enabled: data.enabled,
        alertEmail: data.alertEmail ?? '',
        notifyPastDue: data.notifyPastDue,
        notifyTrialExpiring: data.notifyTrialExpiring,
        trialExpiringDays: data.trialExpiringDays,
      });
    }
  }, [data]);

  async function onSave() {
    try {
      await update.mutateAsync(form);
      toast.success('Alertas actualizadas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onRun() {
    try {
      const res = await run.mutateAsync();
      if (res.sent) {
        toast.success(
          `Digest enviado: ${res.pastDue} pago(s) fallido(s), ${res.trialExpiring} trial(es).`,
        );
      } else {
        toast.info(
          res.reason === 'no_signals'
            ? 'No hay señales que reportar ahora mismo.'
            : 'Alertas desactivadas o sin email configurado.',
        );
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alertas de plataforma</h1>
        <p className="text-sm text-muted-foreground">
          Recibe un digest diario por email con tenants en pago fallido y trials por expirar.
        </p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Configuración</CardTitle>
          <CardDescription>El cron envía el digest a las 07:00 si hay señales.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v === true }))}
            />
            Activar alertas
          </label>
          <div className="space-y-1">
            <Label>Email de destino</Label>
            <Input
              type="email"
              placeholder="equipo@storageos.com"
              value={form.alertEmail}
              onChange={(e) => setForm((f) => ({ ...f, alertEmail: e.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.notifyPastDue}
              onCheckedChange={(v) => setForm((f) => ({ ...f, notifyPastDue: v === true }))}
            />
            Avisar de pagos fallidos (past_due)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.notifyTrialExpiring}
              onCheckedChange={(v) => setForm((f) => ({ ...f, notifyTrialExpiring: v === true }))}
            />
            Avisar de trials por expirar
          </label>
          <div className="space-y-1">
            <Label>Días de antelación del trial</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={form.trialExpiringDays}
              onChange={(e) =>
                setForm((f) => ({ ...f, trialExpiringDays: e.target.valueAsNumber || 3 }))
              }
              className="w-24"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={update.isPending}>
              Guardar
            </Button>
            <Button variant="outline" onClick={onRun} disabled={run.isPending}>
              Evaluar y enviar ahora
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
