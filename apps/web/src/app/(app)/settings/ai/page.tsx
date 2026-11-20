'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { WebChatCard } from './web-chat-card';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAiUsage,
  useTenantAiSettings,
  useTestTenantAiSettings,
  useUpdateTenantAiSettings,
} from '@/lib/ai/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import { formatDate, formatNumber } from '@/lib/format';

/** Consultas del asistente IA y la clave propia del negocio. */
export default function AiSettingsPage() {
  const ask = useConfirm();
  // Sin el asistente en el plan (p. ej. tras bajar de plan) solo se puede
  // quitar la clave guardada.
  const hasFeature = useHasFeature('ai_assistant');
  const usage = useAiUsage(hasFeature);
  const settings = useTenantAiSettings();
  const update = useUpdateTenantAiSettings();
  const test = useTestTenantAiSettings();
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  const loaded = useRef(false);
  useEffect(() => {
    if (!settings.data || loaded.current) return;
    loaded.current = true;
    setModel(settings.data.ownModel ?? '');
  }, [settings.data]);

  async function save(input: { apiKey?: string; model?: string }, done: string) {
    try {
      await update.mutateAsync(input);
      setApiKey('');
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function removeKey() {
    if (
      !(await ask({
        title: '¿Quitar tu clave de IA?',
        description: own
          ? 'TrasterOS ha dejado el asistente con vuestra propia clave: sin ella, el asistente dejará de responder hasta que pongáis otra.'
          : 'Cuando se gasten las consultas del mes, el asistente dejará de responder hasta el mes siguiente.',
        confirmLabel: 'Quitar',
        destructive: true,
      }))
    )
      return;
    await save({ apiKey: '' }, 'Clave quitada.');
  }

  /** Prueba la clave escrita (sin guardarla) o, si no hay, la guardada. */
  async function runTest() {
    const typed = apiKey.trim();
    try {
      const r = await test.mutateAsync(
        typed ? { apiKey: typed, ...(model.trim() ? { model: model.trim() } : {}) } : {},
      );
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar.');
    }
  }

  const s = settings.data;
  const own = s?.mode === 'own';
  if (settings.isLoading || usage.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (settings.isError) return <SectionError onRetry={() => void settings.refetch()} />;
  const u = usage.data;
  // Comprobación rápida antes de enviar (el servidor también la hace).
  const typedKey = apiKey.trim();
  const keyLooksWrong = !!typedKey && (typedKey.length < 20 || /\s/.test(typedKey));

  if (!hasFeature) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Asistente IA</h1>
          <p className="text-sm text-muted-foreground">
            El asistente IA ya no está en vuestro plan. Podéis quitar la clave que dejasteis
            guardada.
          </p>
        </div>
        {s?.ownKeyConfigured && (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <p className="text-sm">
                Clave guardada, termina en <span className="font-mono">{s.ownKeyLast4}</span>.
              </p>
              <Button variant="outline" onClick={removeKey} disabled={update.isPending}>
                Quitar la clave
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Asistente IA</h1>
        <p className="text-sm text-muted-foreground">
          Lo que consume el asistente del panel y del área de clientes, y tu propia clave para que
          siga respondiendo cuando se gasten las consultas del mes.
        </p>
      </div>

      {usage.isError && (
        <Card>
          <CardContent>
            <SectionError onRetry={() => void usage.refetch()} />
          </CardContent>
        </Card>
      )}
      {u && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consultas de este mes</CardTitle>
            <CardDescription>
              {own
                ? 'Usáis vuestra propia clave: las consultas no tienen límite de TrasterOS.'
                : `${formatNumber(u.used, 0)} de ${formatNumber(u.limit, 0)} consultas. Se reinicia el ${formatDate(u.resetsOn)}.`}
              {u.ownQueries > 0 && ` ${formatNumber(u.ownQueries, 0)} con vuestra clave.`}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tu propia clave de IA</CardTitle>
          <CardDescription>
            {own
              ? 'El asistente responde siempre con esta clave y el coste lo cobra Anthropic directamente a vuestra cuenta.'
              : 'Opcional. Cuando se gasten las consultas del mes, el asistente sigue respondiendo con esta clave en vez de pararse; esas consultas las cobra Anthropic a vuestra cuenta y no cuentan para el límite.'}{' '}
            Crea la clave en console.anthropic.com → API Keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {s?.ownKeyConfigured && (
            <p className="text-sm">
              Clave guardada, termina en <span className="font-mono">{s.ownKeyLast4}</span>.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-own-key">
                {s?.ownKeyConfigured ? 'Cambiar la clave' : 'Clave de Anthropic'}
              </Label>
              <Input
                id="ai-own-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-…"
                className="text-base sm:text-sm"
              />
              {keyLooksWrong && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  La clave parece incompleta o lleva espacios: cópiala entera.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-own-model">Modelo</Label>
              <Input
                id="ai-own-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={s?.defaultModel}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">Vacío = {s?.defaultModel}.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                save(
                  { ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), model: model.trim() },
                  'Clave guardada.',
                )
              }
              disabled={
                update.isPending || keyLooksWrong || (!apiKey.trim() && !s?.ownKeyConfigured)
              }
            >
              {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Guardar
            </Button>
            {(typedKey || s?.ownKeyConfigured) && (
              <Button
                variant="outline"
                onClick={runTest}
                disabled={test.isPending || keyLooksWrong}
              >
                {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {typedKey ? 'Probar la clave escrita' : 'Probar la clave'}
              </Button>
            )}
            {s?.ownKeyConfigured && (
              <Button variant="outline" onClick={removeKey} disabled={update.isPending}>
                Quitar la clave
              </Button>
            )}
          </div>
          {own && !s?.ownKeyConfigured && (
            <p className="text-sm text-red-600">
              Sin clave el asistente no responde: TrasterOS ha dejado el asistente con vuestra
              propia clave.
            </p>
          )}
        </CardContent>
      </Card>

      <WebChatCard />
    </div>
  );
}
