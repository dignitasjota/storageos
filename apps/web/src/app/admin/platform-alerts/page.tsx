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
  useChatAlertSettings,
  useAdminAlertLog,
  useAdminPlatformAlerts,
  useRunPlatformAlerts,
  useRunWeeklyDigest,
  useUpdatePlatformAlerts,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

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
    dailyHour: 7,
    chatContactEnabled: true,
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
        dailyHour: data.dailyHour,
        chatContactEnabled: data.chatContactEnabled,
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
            Cada día a la hora que elijas (hora de España), solo si hay algo. No cuenta las cuentas
            exentas ni las suspendidas. También avisa si el gasto de IA del mes pasa del aviso de
            Asistente IA.
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
            <Label>Emails de destino</Label>
            <Input
              type="text"
              inputMode="email"
              placeholder="tu@trasteros.pro, socio@trasteros.pro"
              value={form.alertEmail}
              onChange={(e) => setForm((f) => ({ ...f, alertEmail: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Uno o varios, separados por comas. También reciben el resumen semanal.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="daily-hour">Hora del aviso diario</Label>
            <select
              id="daily-hour"
              value={form.dailyHour}
              onChange={(e) => setForm((f) => ({ ...f, dailyHour: Number(e.target.value) }))}
              className="h-9 w-28 rounded-md border border-input bg-background px-2 text-base sm:text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
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

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Mensajes de la web</CardTitle>
          <CardDescription>
            Cada mensaje del formulario de contacto de trasteros.pro te llega al momento por
            Telegram o Slack (si están configurados arriba), además de al email del formulario.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.chatContactEnabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, chatContactEnabled: v === true }))}
            />
            Avisarme por chat de cada mensaje de contacto
          </label>
          <Button onClick={onSave} disabled={update.isPending || !canEdit}>
            Guardar
          </Button>
        </CardContent>
      </Card>

      <AlertMatrix
        email={{
          daily: form.enabled && !!form.alertEmail,
          weekly: form.weeklyDigestEnabled && !!form.alertEmail,
        }}
        contactChat={form.chatContactEnabled}
      />

      <AlertLogCard />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  daily: 'Aviso diario',
  weekly: 'Resumen semanal',
  commercial: 'Aviso comercial',
  contact: 'Mensaje de la web',
  test: 'Prueba',
  other: 'Otro',
};
const CHANNEL_LABEL: Record<string, string> = {
  email: 'Email',
  telegram: 'Telegram',
  slack: 'Slack',
};

/** Qué aviso va por cada canal (resumen de los ajustes de esta página). */
function AlertMatrix({
  email,
  contactChat,
}: {
  email: { daily: boolean; weekly: boolean };
  contactChat: boolean;
}) {
  const chat = useChatAlertSettings();
  const c = chat.data;
  const chatOn = !!c && (c.telegramConfigured || c.slackConfigured);
  const rows: [string, boolean | null, boolean][] = [
    ['Aviso diario', email.daily, chatOn && !!c?.dailyEnabled],
    ['Resumen semanal', email.weekly, chatOn && !!c?.weeklyEnabled],
    ['Avisos comerciales', null, chatOn && !!c?.commercialEnabled],
    ['Mensajes de la web', null, chatOn && contactChat],
  ];
  const mark = (v: boolean | null) =>
    v === null ? (
      <span className="text-muted-foreground">—</span>
    ) : v ? (
      <span className="text-emerald-600">Sí</span>
    ) : (
      <span className="text-muted-foreground">No</span>
    );
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Qué te llega y por dónde</CardTitle>
        <CardDescription>
          Resumen de los ajustes guardados.{' '}
          {!chatOn && 'Configura Telegram o Slack arriba para recibir avisos por chat.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pb-2 font-normal">Aviso</th>
              <th className="pb-2 font-normal">Email</th>
              <th className="pb-2 font-normal">Chat</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map(([label, e, ch]) => (
              <tr key={label}>
                <td className="py-1.5">{label}</td>
                <td className="py-1.5">{mark(e)}</td>
                <td className="py-1.5">{mark(ch)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/** Los últimos avisos enviados (email y chat). */
function AlertLogCard() {
  const log = useAdminAlertLog();
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="text-base">Avisos enviados</CardTitle>
        <CardDescription>Los últimos 100, por email y por chat.</CardDescription>
      </CardHeader>
      <CardContent>
        {log.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (log.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no se ha enviado ninguno.</p>
        ) : (
          <ul className="divide-y text-sm">
            {(log.data ?? []).map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate">{l.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    {KIND_LABEL[l.kind] ?? l.kind} · {CHANNEL_LABEL[l.channel] ?? l.channel}
                    {!l.ok && l.error && <span className="text-destructive"> · {l.error}</span>}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDateTime(l.createdAt)}
                  {!l.ok && <span className="ml-1 text-destructive">✕</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
