'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ChatAlertsCard } from './chat-alerts-card';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAdminPlatformAlerts,
  useRunPlatformAlerts,
  useRunWeeklyDigest,
  useUpdatePlatformAlerts,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

export default function PlatformAlertsPage() {
  const canEdit = useIsSuperadmin();
  const { data, isLoading } = useAdminPlatformAlerts();
  const update = useUpdatePlatformAlerts();
  const run = useRunPlatformAlerts();
  const runDigest = useRunWeeklyDigest();

  const [form, setForm] = useState({
    enabled: false,
    alertEmail: '',
    notifyPastDue: true,
    notifyTrialExpiring: true,
    trialExpiringDays: 3,
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
        <h1 className="text-2xl font-semibold tracking-tight">Alertas al admin</h1>
        <p className="text-sm text-muted-foreground">
          Lo que te llega a ti: el aviso diario por email con los tenants con el pago pendiente y
          las pruebas que terminan, el resumen semanal y los avisos por Telegram o Slack.
        </p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Configuración</CardTitle>
          <CardDescription>
            Cada día a las 07:00 (hora de España), solo si hay algo. No cuenta las cuentas exentas
            ni las suspendidas.
          </CardDescription>
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
              placeholder="tu@trasteros.pro"
              value={form.alertEmail}
              onChange={(e) => setForm((f) => ({ ...f, alertEmail: e.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.notifyPastDue}
              onCheckedChange={(v) => setForm((f) => ({ ...f, notifyPastDue: v === true }))}
            />
            Avisar de pagos pendientes
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.notifyTrialExpiring}
              onCheckedChange={(v) => setForm((f) => ({ ...f, notifyTrialExpiring: v === true }))}
            />
            Avisar de pruebas que terminan pronto
          </label>
          <div className="space-y-1">
            <Label>Días de antelación de la prueba</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={Number.isNaN(form.trialExpiringDays) ? '' : form.trialExpiringDays}
              onChange={(e) =>
                setForm((f) => ({ ...f, trialExpiringDays: e.target.valueAsNumber }))
              }
              className="w-24"
            />
          </div>
          <div className="flex gap-2">
            <Button
              onClick={onSave}
              disabled={
                update.isPending ||
                !canEdit ||
                !(form.trialExpiringDays >= 1 && form.trialExpiringDays <= 30)
              }
            >
              Guardar
            </Button>
            <Button variant="outline" onClick={onRun} disabled={run.isPending || !canEdit}>
              Evaluar y enviar ahora
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Resumen semanal de KPIs</CardTitle>
          <CardDescription>
            Recibe cada lunes a las 08:00 (hora de España) un email con los KPIs clave (MRR y su
            variación, net new MRR, churn, ARPU, nuevos tenants, trials por convertir y tickets
            abiertos) al email de destino de arriba, sin entrar al panel.
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
            <Button onClick={onSave} disabled={update.isPending || !canEdit}>
              Guardar
            </Button>
            <Button
              variant="outline"
              onClick={onRunDigest}
              disabled={runDigest.isPending || !canEdit}
            >
              Enviar ahora
            </Button>
          </div>
        </CardContent>
      </Card>

      <p className="max-w-xl text-sm text-muted-foreground">
        Los correos automáticos a los tenants (bienvenida, fin de la prueba, impago) se activan y se
        redactan en{' '}
        <Link href="/admin/email-templates" className="text-primary hover:underline">
          Comunicación → Correos automáticos
        </Link>
        .
      </p>

      <ChatAlertsCard />
    </div>
  );
}
