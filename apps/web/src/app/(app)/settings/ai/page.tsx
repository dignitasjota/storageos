'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

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
import { formatDate, formatNumber } from '@/lib/format';

/** Consultas del asistente IA y la clave propia del negocio. */
export default function AiSettingsPage() {
  const usage = useAiUsage();
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

  async function runTest() {
    try {
      const r = await test.mutateAsync();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar.');
    }
  }

  if (settings.isLoading || usage.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const u = usage.data;
  const s = settings.data;
  const own = s?.mode === 'own';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Asistente IA</h1>
        <p className="text-sm text-muted-foreground">
          Lo que consume el asistente del panel y del área de clientes, y tu propia clave para que
          siga respondiendo cuando se gasten las consultas del mes.
        </p>
      </div>

      {u && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consultas de este mes</CardTitle>
            <CardDescription>
              {own
                ? 'Usáis vuestra propia clave: las consultas no tienen límite de TrasterOS.'
                : `${formatNumber(u.used)} de ${formatNumber(u.limit)} consultas. Se reinicia el ${formatDate(u.resetsOn)}.`}
              {u.ownQueries > 0 && ` ${formatNumber(u.ownQueries)} con vuestra clave.`}
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
              disabled={update.isPending || (!apiKey.trim() && !s?.ownKeyConfigured)}
            >
              {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Guardar
            </Button>
            {s?.ownKeyConfigured && (
              <>
                <Button variant="outline" onClick={runTest} disabled={test.isPending}>
                  {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Probar la clave
                </Button>
                <Button
                  variant="outline"
                  onClick={() => save({ apiKey: '' }, 'Clave quitada.')}
                  disabled={update.isPending}
                >
                  Quitar la clave
                </Button>
              </>
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
    </div>
  );
}
