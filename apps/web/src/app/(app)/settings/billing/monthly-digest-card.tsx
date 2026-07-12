'use client';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useMonthlyDigestSettings,
  useRunMonthlyDigest,
  useUpdateMonthlyDigest,
} from '@/lib/tenant-settings/hooks';

export function MonthlyDigestCard() {
  const canManage = useHasPermission('settings:manage');
  const { data } = useMonthlyDigestSettings();
  const update = useUpdateMonthlyDigest();
  const run = useRunMonthlyDigest();
  const enabled = data?.enabled ?? false;

  async function toggle(v: boolean) {
    try {
      await update.mutateAsync(v);
      toast.success(v ? 'Informe mensual activado.' : 'Informe mensual desactivado.');
    } catch {
      toast.error('No se pudo guardar.');
    }
  }

  async function sendNow() {
    try {
      const res = await run.mutateAsync();
      toast.success(
        res.sent
          ? `Informe enviado a ${res.recipients} destinatario(s).`
          : 'No hay destinatarios verificados a los que enviar.',
      );
    } catch {
      toast.error('No se pudo enviar el informe.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Informe mensual del negocio</CardTitle>
        <CardDescription>
          Recibe por email, el día 1 de cada mes, un resumen: ocupación, ingresos, morosidad,
          inquilinos y leads. Se envía a los propietarios de la cuenta.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            disabled={!canManage || update.isPending}
            onCheckedChange={(v) => toggle(v === true)}
          />
          Enviarme el informe mensual por email
        </label>
        {canManage && (
          <Button variant="outline" size="sm" onClick={sendNow} disabled={run.isPending}>
            {run.isPending ? 'Enviando…' : 'Enviar el del mes pasado ahora'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
