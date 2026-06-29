'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { ApiError } from '@/lib/auth/api';
import {
  useGoCardlessSettings,
  useTestGoCardless,
  useUpdateGoCardlessSettings,
} from '@/lib/payments/gocardless';

export function GoCardlessCard() {
  const settings = useGoCardlessSettings();
  const update = useUpdateGoCardlessSettings();
  const test = useTestGoCardless();

  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('sandbox');
  const [accessToken, setAccessToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const data = settings.data;
  if (data && !initialized) {
    setEnvironment(data.environment);
    setEnabled(data.enabled);
    setInitialized(true);
  }

  async function save() {
    try {
      await update.mutateAsync({
        environment,
        enabled,
        ...(accessToken ? { accessToken } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
      });
      setAccessToken('');
      setWebhookSecret('');
      toast.success('GoCardless guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
    }
  }

  async function runTest() {
    const res = await test.mutateAsync();
    if (res.ok) {
      toast.success(`Conexión correcta${res.creditorName ? ` — ${res.creditorName}` : ''}.`);
    } else {
      toast.error(`No se pudo conectar: ${res.error ?? 'error'}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Domiciliación SEPA — GoCardless</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Cobro por domiciliación SEPA gestionada (mandatos + cobros automáticos vía GoCardless, sin
          generar remesas). El access token y el webhook secret se guardan cifrados.
        </p>

        <div className="space-y-1">
          <Label>Entorno</Label>
          <Select
            value={environment}
            onValueChange={(v) => setEnvironment(v as 'sandbox' | 'live')}
          >
            <SelectTrigger className="sm:w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sandbox">Pruebas (sandbox)</SelectItem>
              <SelectItem value="live">Producción (live)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label>Access token</Label>
          <Input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={
              data?.hasAccessToken ? '•••••••• (guardado)' : 'Access token de GoCardless'
            }
          />
        </div>

        <div className="space-y-1">
          <Label>Webhook secret</Label>
          <Input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={
              data?.hasWebhookSecret ? '•••••••• (guardado)' : 'Secret del endpoint de webhook'
            }
          />
          <p className="text-xs text-muted-foreground">
            En el dashboard de GoCardless, crea un webhook apuntando a{' '}
            <code>/webhooks/gocardless/&lt;tu-tenant-id&gt;</code> y pega aquí su secret.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Activar domiciliación por GoCardless
        </label>

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
          <Button
            variant="outline"
            onClick={runTest}
            disabled={test.isPending || !data?.hasAccessToken}
          >
            {test.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : test.data?.ok ? (
              <CheckCircle2 className="mr-1 h-4 w-4 text-green-600" />
            ) : test.data && !test.data.ok ? (
              <XCircle className="mr-1 h-4 w-4 text-red-600" />
            ) : null}
            Probar conexión
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
