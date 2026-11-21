'use client';

import { CheckCircle2, Copy, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
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
import { savedMethodsWarning, useSavedMethodsSummary } from '@/lib/payments/saved-methods';

export function GoCardlessCard() {
  const settings = useGoCardlessSettings();
  const update = useUpdateGoCardlessSettings();
  const test = useTestGoCardless();
  const confirm = useConfirm();
  const saved = useSavedMethodsSummary();

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
    // Apagar GoCardless deja sin cobrar los mandatos de los inquilinos.
    const warning =
      data?.enabled && !enabled
        ? savedMethodsWarning(
            saved.data?.gocardless,
            {
              saved: ['mandato de domiciliación', 'mandatos de domiciliación'],
              charge: 'cobrarse solas por domiciliación',
              reversible: true,
            },
            saved.data?.autoChargeOnIssue ?? false,
          )
        : null;
    if (warning) {
      const ok = await confirm({
        title: 'Desactivar GoCardless',
        description: warning,
        confirmLabel: 'Desactivar',
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await update.mutateAsync({
        environment,
        enabled,
        ...(accessToken ? { accessToken } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
      });
      setAccessToken('');
      setWebhookSecret('');
      void saved.refetch();
      toast.success('GoCardless guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
    }
  }

  async function runTest() {
    try {
      const res = await test.mutateAsync();
      if (res.ok) {
        toast.success(`Conexión correcta${res.creditorName ? ` — ${res.creditorName}` : ''}.`);
      } else {
        toast.error(`No se pudo conectar: ${res.error ?? 'error'}`);
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.body.message : 'No se ha podido probar la conexión.',
      );
    }
  }

  async function copyWebhookUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Dirección copiada.');
    } catch {
      toast.error('No se ha podido copiar. Selecciónala y cópiala a mano.');
    }
  }

  if (settings.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domiciliación SEPA — GoCardless</CardTitle>
        </CardHeader>
        <CardContent>
          <SectionError onRetry={() => void settings.refetch()} />
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domiciliación SEPA — GoCardless</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
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
            placeholder={data.hasAccessToken ? '•••••••• (guardado)' : 'Access token de GoCardless'}
          />
        </div>

        <div className="space-y-1">
          <Label>Webhook secret</Label>
          <Input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={
              data.hasWebhookSecret ? '•••••••• (guardado)' : 'Secret del endpoint de webhook'
            }
          />
          <p className="text-xs text-muted-foreground">
            En el panel de GoCardless, crea un webhook con esta dirección y pega aquí su secret:
          </p>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={data.webhookUrl}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Dirección del webhook"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void copyWebhookUrl(data.webhookUrl)}
              aria-label="Copiar la dirección del webhook"
              title="Copiar"
            >
              <Copy className="size-4" />
            </Button>
          </div>
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
            disabled={test.isPending || !data.hasAccessToken}
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
