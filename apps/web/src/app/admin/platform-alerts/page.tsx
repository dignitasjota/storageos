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
  useRunTenantLifecycleEmails,
  useRunWeeklyDigest,
  useUpdatePlatformAlerts,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

export default function PlatformAlertsPage() {
  const { data, isLoading } = useAdminPlatformAlerts();
  const update = useUpdatePlatformAlerts();
  const run = useRunPlatformAlerts();
  const runLifecycle = useRunTenantLifecycleEmails();
  const runDigest = useRunWeeklyDigest();

  const [form, setForm] = useState({
    enabled: false,
    alertEmail: '',
    notifyPastDue: true,
    notifyTrialExpiring: true,
    trialExpiringDays: 3,
    lifecycleEnabled: false,
    sendWelcome: true,
    sendTrialReminders: true,
    sendPastDue: true,
    weeklyDigestEnabled: false,
  });

  useEffect(() => {
    if (data) {
      setForm({
        enabled: data.enabled,
        alertEmail: data.alertEmail ?? '',
        notifyPastDue: data.notifyPastDue,
        notifyTrialExpiring: data.notifyTrialExpiring,
        trialExpiringDays: data.trialExpiringDays,
        lifecycleEnabled: data.lifecycleEnabled,
        sendWelcome: data.sendWelcome,
        sendTrialReminders: data.sendTrialReminders,
        sendPastDue: data.sendPastDue,
        weeklyDigestEnabled: data.weeklyDigestEnabled,
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

  async function onRunDigest() {
    try {
      const res = await runDigest.mutateAsync();
      if (res.sent) {
        toast.success('Resumen semanal de KPIs enviado.');
      } else {
        toast.info('Activa el resumen semanal y configura un email de destino.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onRunLifecycle() {
    try {
      const res = await runLifecycle.mutateAsync();
      const total = res.welcome + res.trialReminders + res.pastDue;
      if (total > 0) {
        toast.success(
          `Emails encolados: ${res.welcome} bienvenida, ${res.trialReminders} trial, ${res.pastDue} pago fallido.`,
        );
      } else {
        toast.info('No hay emails de ciclo de vida pendientes ahora mismo.');
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

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Resumen semanal de KPIs</CardTitle>
          <CardDescription>
            Recibe cada lunes a las 08:00 un email con los KPIs clave (MRR y su variación, net new
            MRR, churn, ARPU, nuevos tenants, trials por convertir y tickets abiertos) al email de
            destino de arriba, sin entrar al panel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.weeklyDigestEnabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, weeklyDigestEnabled: v === true }))}
            />
            Resumen semanal de KPIs por email
          </label>
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={update.isPending}>
              Guardar
            </Button>
            <Button variant="outline" onClick={onRunDigest} disabled={runDigest.isPending}>
              Enviar ahora
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Emails automáticos al tenant</CardTitle>
          <CardDescription>
            Correos automáticos al owner del tenant: bienvenida al alta, recordatorios de trial (7,
            3 y 1 días antes) y aviso de pago fallido. Un cron diario (08:00) los envía; cada tipo
            se manda una sola vez por tenant.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.lifecycleEnabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, lifecycleEnabled: v === true }))}
            />
            Activar emails de ciclo de vida
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.sendWelcome}
              onCheckedChange={(v) => setForm((f) => ({ ...f, sendWelcome: v === true }))}
            />
            Email de bienvenida (al dar de alta)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.sendTrialReminders}
              onCheckedChange={(v) => setForm((f) => ({ ...f, sendTrialReminders: v === true }))}
            />
            Recordatorios de trial por expirar (7 / 3 / 1 días)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.sendPastDue}
              onCheckedChange={(v) => setForm((f) => ({ ...f, sendPastDue: v === true }))}
            />
            Aviso de pago fallido (past_due)
          </label>
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={update.isPending}>
              Guardar
            </Button>
            <Button variant="outline" onClick={onRunLifecycle} disabled={runLifecycle.isPending}>
              Ejecutar ahora
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
