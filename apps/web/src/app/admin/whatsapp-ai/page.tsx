'use client';

import { WHATSAPP_AI_PROVIDERS, type WhatsappAiProvider } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAdminWhatsappAi,
  useTestAdminWhatsappAi,
  useUpdateAdminWhatsappAi,
} from '@/lib/admin/whatsapp-ai-hooks';
import { ApiError } from '@/lib/auth/api';

/**
 * IA del asistente de WhatsApp de la plataforma (distinta de la del asistente
 * del panel). La usan los tenants con el extra de WhatsApp en modo «IA de
 * TrasterOS», hasta su límite de respuestas al mes.
 */
export default function AdminWhatsappAiPage() {
  const settings = useAdminWhatsappAi();
  const update = useUpdateAdminWhatsappAi();
  const test = useTestAdminWhatsappAi();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<WhatsappAiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [limit, setLimit] = useState('300');

  const loaded = useRef(false);
  useEffect(() => {
    if (!settings.data || loaded.current) return;
    loaded.current = true;
    setEnabled(settings.data.enabled);
    setProvider(settings.data.provider);
    setModel(settings.data.model);
    setBaseUrl(settings.data.baseUrl ?? '');
    setLimit(String(settings.data.monthlyReplyLimit));
  }, [settings.data]);

  const preset = WHATSAPP_AI_PROVIDERS.find((p) => p.value === provider);

  async function save() {
    try {
      await update.mutateAsync({
        enabled,
        provider,
        model: model.trim(),
        baseUrl: provider === 'openai_compatible' ? baseUrl.trim() : '',
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        monthlyReplyLimit: Math.max(0, Number.parseInt(limit, 10) || 0),
      });
      setApiKey('');
      toast.success('IA de WhatsApp guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function runTest() {
    try {
      const r = await test.mutateAsync();
      if (r.ok) toast.success(`Funciona. Respuesta: «${r.sample ?? ''}»`);
      else toast.error(r.error ?? 'No funciona.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar.');
    }
  }

  if (settings.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">IA de WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          La IA con la que responde el asistente de WhatsApp de los tenants (distinta de la del
          asistente del panel). Cada tenant la usa hasta su límite de respuestas al mes; pasado el
          límite, si tiene su propia clave, se cambia sola a la suya. El modo de cada tenant se
          cambia en su ficha.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Proveedor y clave</CardTitle>
          <CardDescription>
            Los mensajes de los clientes (nombre, teléfono y lo que escriben) se envían al
            proveedor. Si está fuera de la UE, recógelo en la política de privacidad y en el
            contrato de encargo con los tenants.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Proveedor</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v as WhatsappAiProvider);
                  const p = WHATSAPP_AI_PROVIDERS.find((x) => x.value === v);
                  if (p?.defaultModel) setModel(p.defaultModel);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHATSAPP_AI_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wa-ai-model">Modelo</Label>
              <Input
                id="wa-ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={preset?.defaultModel || 'Nombre del modelo'}
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          {provider === 'openai_compatible' && (
            <div className="space-y-1.5">
              <Label htmlFor="wa-ai-url">URL de la API</Label>
              <Input
                id="wa-ai-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.proveedor.com/v1"
                className="text-base sm:text-sm"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="wa-ai-key">Clave de API</Label>
            <Input
              id="wa-ai-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                settings.data?.keyLast4
                  ? `Guardada (termina en ${settings.data.keyLast4}). Escribe otra para cambiarla.`
                  : 'Pega aquí la clave'
              }
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-ai-limit">Respuestas al mes por tenant</Label>
            <Input
              id="wa-ai-limit"
              type="number"
              min={0}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-40 text-base sm:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Se puede cambiar por tenant en su ficha. 0 = solo con su propia clave.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            Activar la IA de WhatsApp de la plataforma
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Guardar
            </Button>
            <Button variant="outline" onClick={runTest} disabled={test.isPending}>
              {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Probar
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
