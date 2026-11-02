'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useAdminPlatformAlerts,
  useRunTenantLifecycleEmails,
  useUpdatePlatformAlerts,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const TOGGLES = [
  { key: 'sendWelcome', label: 'Bienvenida (al darse de alta)' },
  { key: 'sendTrialReminders', label: 'La prueba termina pronto (7, 3 y 1 días antes)' },
  { key: 'sendPastDue', label: 'Pago de la cuota pendiente' },
] as const;

type Toggles = {
  lifecycleEnabled: boolean;
  sendWelcome: boolean;
  sendTrialReminders: boolean;
  sendPastDue: boolean;
  sendActivation: boolean;
};

/** Qué correos automáticos salen a los tenants (los textos, en la misma página). */
export function LifecycleSettingsCard() {
  const canEdit = useIsSuperadmin();
  const { data, isLoading } = useAdminPlatformAlerts();
  const update = useUpdatePlatformAlerts();
  const run = useRunTenantLifecycleEmails();
  const [form, setForm] = useState<Toggles | null>(null);

  useEffect(() => {
    if (data && !form) {
      setForm({
        lifecycleEnabled: data.lifecycleEnabled,
        sendWelcome: data.sendWelcome,
        sendTrialReminders: data.sendTrialReminders,
        sendPastDue: data.sendPastDue,
        sendActivation: data.sendActivation,
      });
    }
  }, [data, form]);

  async function onSave() {
    if (!data || !form) return;
    try {
      // El PUT exige también los ajustes de las alertas: se reenvían tal cual.
      await update.mutateAsync({
        enabled: data.enabled,
        alertEmail: data.alertEmail ?? '',
        notifyPastDue: data.notifyPastDue,
        notifyTrialExpiring: data.notifyTrialExpiring,
        trialExpiringDays: data.trialExpiringDays,
        ...form,
      });
      toast.success('Guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onRun() {
    try {
      const res = await run.mutateAsync();
      const total =
        res.welcome +
        res.trialReminders +
        res.pastDue +
        res.activationNudges +
        res.suspensionNotices;
      if (res.trialsEnded > 0) {
        toast.info(`${res.trialsEnded} pruebas vencidas han pasado al plan Free.`);
      }
      if (total > 0) {
        toast.success(
          `Correos encolados: ${res.welcome} bienvenida, ${res.trialReminders} prueba, ${res.activationNudges} ayuda para arrancar, ${res.pastDue} pago pendiente, ${res.suspensionNotices} suspensión.`,
        );
      } else if (res.trialsEnded === 0) {
        toast.info('No hay correos automáticos pendientes ahora mismo.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo ejecutar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Cuáles se envían</CardTitle>
        <CardDescription>
          Cada día a las 08:00 (hora de España); cada correo se manda una sola vez por tenant. A los
          propietarios con el email verificado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !form ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={form.lifecycleEnabled}
                onCheckedChange={(v) => setForm({ ...form, lifecycleEnabled: v === true })}
              />
              Enviar los correos automáticos
            </label>
            <div className={`space-y-2 pl-6 ${form.lifecycleEnabled ? '' : 'opacity-50'}`}>
              {TOGGLES.map((t) => (
                <label key={t.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form[t.key]}
                    onCheckedChange={(v) => setForm({ ...form, [t.key]: v === true })}
                  />
                  {t.label}
                </label>
              ))}
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={form.sendActivation}
                  onCheckedChange={(v) => setForm({ ...form, sendActivation: v === true })}
                />
                <span>
                  Ayuda para arrancar según el uso de la prueba
                  <span className="block text-xs text-muted-foreground">
                    Día 3 sin locales, día 7 sin inquilinos y día 12 sin facturas (este último
                    también te deja un seguimiento para llamarle).
                  </span>
                </span>
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void onSave()} disabled={update.isPending || !canEdit}>
                Guardar
              </Button>
              <Button
                variant="outline"
                onClick={() => void onRun()}
                disabled={run.isPending || !canEdit}
              >
                Enviar los pendientes ahora
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
