'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useBackfillHolded,
  useHoldedSettings,
  useTestHolded,
  useUpdateHoldedSettings,
} from '@/lib/accounting/hooks';
import { ApiError } from '@/lib/auth/api';

export function HoldedCard() {
  const settings = useHoldedSettings();
  const update = useUpdateHoldedSettings();
  const test = useTestHolded();
  const backfill = useBackfillHolded();

  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Inicializa el switch con el estado del servidor una sola vez.
  if (settings.data && !initialized) {
    setEnabled(settings.data.enabled);
    setInitialized(true);
  }

  async function save() {
    try {
      await update.mutateAsync({ enabled, ...(apiKey ? { apiKey } : {}) });
      setApiKey('');
      toast.success('Integración con Holded guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
    }
  }

  async function runTest() {
    const res = await test.mutateAsync();
    if (res.ok) toast.success(res.message);
    else toast.error(res.message);
  }

  async function runBackfill() {
    try {
      const res = await backfill.mutateAsync();
      toast.success(`${res.synced} factura(s) exportada(s) a Holded.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error en el backfill');
    }
  }

  const data = settings.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contabilidad — Holded</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Exporta automáticamente cada factura emitida a tu cuenta de Holded (crea el contacto y el
          documento). La API key se guarda cifrada.
        </p>

        <div className="space-y-1">
          <Label>API key de Holded</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data?.hasApiKey ? '•••••••• (guardada)' : 'Pega tu API key'}
          />
          <p className="text-xs text-muted-foreground">
            En Holded: Ajustes → Desarrolladores → API. Déjalo vacío para conservar la actual.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Exportar facturas a Holded automáticamente
        </label>

        {data?.lastSyncAt && (
          <p className="text-xs text-muted-foreground">
            Última sincronización: {new Date(data.lastSyncAt).toLocaleString('es-ES')}
          </p>
        )}
        {data?.lastError && (
          <p className="text-xs text-destructive">Último error: {data.lastError}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
          <Button variant="outline" onClick={runTest} disabled={test.isPending || !data?.hasApiKey}>
            {test.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Probar conexión
          </Button>
          <Button
            variant="ghost"
            onClick={runBackfill}
            disabled={backfill.isPending || !data?.enabled}
          >
            {backfill.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Exportar pendientes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
