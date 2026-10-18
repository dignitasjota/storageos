'use client';

import { MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { ChatAlertSendResultDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useChatAlertAction,
  useChatAlertSettings,
  useUpdateChatAlertSettings,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const CHANNEL: Record<string, string> = { sent: 'enviado', failed: 'falló', off: 'sin configurar' };

function report(r: ChatAlertSendResultDto, what: string): void {
  if (r.reason === 'nothing_urgent') {
    toast.info('No hay nada urgente en «Hoy».');
    return;
  }
  if (r.reason === 'no_channel') {
    toast.error('Configura Telegram o Slack primero.');
    return;
  }
  const msg = `${what}: Telegram ${CHANNEL[r.telegram]}, Slack ${CHANNEL[r.slack]}.`;
  if (r.sent) toast.success(msg);
  else toast.error(msg);
}

/** Avisos por Telegram (bot) y Slack (webhook entrante). */
export function ChatAlertsCard() {
  const canEdit = useIsSuperadmin();
  const q = useChatAlertSettings();
  const update = useUpdateChatAlertSettings();
  const test = useChatAlertAction('test');
  const daily = useChatAlertAction('daily/run');
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [slack, setSlack] = useState('');
  const [dailyOn, setDailyOn] = useState(false);
  const [weeklyOn, setWeeklyOn] = useState(false);
  const s = q.data;

  useEffect(() => {
    if (!s) return;
    setChatId(s.telegramChatId ?? '');
    setDailyOn(s.dailyEnabled);
    setWeeklyOn(s.weeklyEnabled);
  }, [s]);

  const fail = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');

  async function save() {
    try {
      await update.mutateAsync({
        ...(token ? { telegramBotToken: token } : {}),
        telegramChatId: chatId.trim(),
        ...(slack ? { slackWebhookUrl: slack.trim() } : {}),
        dailyEnabled: dailyOn,
        weeklyEnabled: weeklyOn,
      });
      setToken('');
      setSlack('');
      toast.success('Avisos por chat guardados.');
    } catch (err) {
      fail(err);
    }
  }

  async function remove(which: 'telegram' | 'slack') {
    try {
      await update.mutateAsync(
        which === 'telegram'
          ? { telegramBotToken: '', telegramChatId: '' }
          : { slackWebhookUrl: '' },
      );
      toast.success(which === 'telegram' ? 'Telegram quitado.' : 'Slack quitado.');
    } catch (err) {
      fail(err);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="size-4" /> Avisos por Telegram y Slack
        </CardTitle>
        <CardDescription>
          Cada mañana (08:15), lo urgente de «Hoy»; los lunes, el resumen semanal. Solo se envía si
          hay algo urgente.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              Telegram{' '}
              <span className="font-normal text-muted-foreground">
                {s?.telegramConfigured ? '· configurado' : '· sin configurar'}
              </span>
            </p>
            {s?.telegramConfigured && canEdit && (
              <Button variant="ghost" size="sm" onClick={() => void remove('telegram')}>
                Quitar
              </Button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tg-token">Token del bot</Label>
              <Input
                id="tg-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={s?.telegramConfigured ? '•••••• (sin cambios)' : '123456:ABC…'}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tg-chat">Chat</Label>
              <Input
                id="tg-chat"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="-1001234567890 o @canal"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Crea un bot con @BotFather, añádelo al grupo o canal y pega aquí su token y el id del
            chat.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              Slack{' '}
              <span className="font-normal text-muted-foreground">
                {s?.slackConfigured ? '· configurado' : '· sin configurar'}
              </span>
            </p>
            {s?.slackConfigured && canEdit && (
              <Button variant="ghost" size="sm" onClick={() => void remove('slack')}>
                Quitar
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="slack-url">Webhook entrante</Label>
            <Input
              id="slack-url"
              type="password"
              autoComplete="off"
              value={slack}
              onChange={(e) => setSlack(e.target.value)}
              placeholder={
                s?.slackConfigured ? '•••••• (sin cambios)' : 'https://hooks.slack.com/services/…'
              }
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={dailyOn} onCheckedChange={(v) => setDailyOn(v === true)} />
            Aviso diario con lo urgente de «Hoy»
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={weeklyOn} onCheckedChange={(v) => setWeeklyOn(v === true)} />
            Resumen semanal de KPIs (lunes)
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} disabled={update.isPending || !canEdit}>
            Guardar
          </Button>
          <Button
            variant="outline"
            disabled={test.isPending || !canEdit}
            onClick={() =>
              test.mutate(undefined, { onSuccess: (r) => report(r, 'Prueba'), onError: fail })
            }
          >
            Enviar prueba
          </Button>
          <Button
            variant="outline"
            disabled={daily.isPending || !canEdit}
            onClick={() =>
              daily.mutate(undefined, { onSuccess: (r) => report(r, '«Hoy»'), onError: fail })
            }
          >
            Enviar «Hoy» ahora
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
