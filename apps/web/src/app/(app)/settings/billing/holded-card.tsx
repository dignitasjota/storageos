'use client';

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { HoldedSeriesDto } from '@storageos/shared';

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
import {
  useBackfillHolded,
  useHoldedSeries,
  useHoldedSettings,
  useTestHolded,
  useUpdateHoldedSettings,
} from '@/lib/accounting/hooks';
import { ApiError } from '@/lib/auth/api';

const NONE = '__none__';

function SeriesSelect({
  label,
  help,
  value,
  onChange,
  options,
}: {
  label: string;
  help: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: HoldedSeriesDto[];
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
        <SelectTrigger>
          <SelectValue placeholder="Elige una serie" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Sin elegir</SelectItem>
          {options.map((s) => (
            <SelectItem key={s.id} value={s.id} disabled={!s.verifactuExcluded}>
              {s.name} ({s.format}){s.verifactuExcluded ? '' : ' — se envía a Verifactu, no válida'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

export function HoldedCard() {
  const settings = useHoldedSettings();
  const update = useUpdateHoldedSettings();
  const test = useTestHolded();
  const backfill = useBackfillHolded();
  const data = settings.data;
  const series = useHoldedSeries(!!data?.hasApiKey);

  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [invoiceSeriesId, setInvoiceSeriesId] = useState<string | null>(null);
  const [creditNoteSeriesId, setCreditNoteSeriesId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Inicializa el formulario con el estado del servidor una sola vez.
  if (data && !initialized) {
    setEnabled(data.enabled);
    setInvoiceSeriesId(data.invoiceSeriesId);
    setCreditNoteSeriesId(data.creditNoteSeriesId);
    setInitialized(true);
  }

  async function save() {
    try {
      await update.mutateAsync({
        enabled,
        ...(apiKey ? { apiKey } : {}),
        ...(data?.hasApiKey ? { invoiceSeriesId, creditNoteSeriesId } : {}),
      });
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
      toast.success(`${res.synced} factura(s) copiada(s) a Holded.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al enviar a Holded');
    }
  }

  const seriesError = series.error instanceof ApiError ? series.error.body.message : null;
  const noExcluded = series.data && !series.data.invoice.some((s) => s.verifactuExcluded);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contabilidad — Holded</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Copia en tu Holded cada factura que emites aquí, con sus cobros, rectificativas y
          anulaciones, para que tu contabilidad esté al día. Las facturas ya se emiten y se
          registran en Veri*Factu desde TrasterOS: Holded solo las contabiliza.
        </p>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Antes de activar: crea una serie solo para TrasterOS</p>
          <p className="mt-1">
            En Holded, Configuración → Numeración, crea una serie de facturas (y otra de
            rectificativas) y márcalas <strong>«No enviar a Verifactu»</strong>. Si Holded enviara
            también estas facturas, quedarían registradas dos veces en la AEAT. Hasta que elijas
            aquí una serie así no se envía nada. En cada factura de Holded verás el número legal de
            TrasterOS en la descripción.
          </p>
        </div>

        <div className="space-y-1">
          <Label>API key de Holded</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data?.hasApiKey ? '•••••••• (guardada)' : 'Pega tu API key (pat_…)'}
          />
          <p className="text-xs text-muted-foreground">
            En Holded: Configuración → Desarrolladores → API. Déjalo vacío para conservar la actual.
          </p>
        </div>

        {data?.hasApiKey ? (
          series.isLoading ? (
            <p className="text-xs text-muted-foreground">Cargando las series de Holded…</p>
          ) : seriesError ? (
            <p className="text-xs text-destructive">
              No se pudieron leer las series: {seriesError}
            </p>
          ) : series.data ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <SeriesSelect
                label="Serie de facturas"
                help="Donde se copian las facturas. Obligatoria."
                value={invoiceSeriesId}
                onChange={setInvoiceSeriesId}
                options={series.data.invoice}
              />
              <SeriesSelect
                label="Serie de rectificativas"
                help="Para las rectificativas (abonos). Sin ella no se copian."
                value={creditNoteSeriesId}
                onChange={setCreditNoteSeriesId}
                options={series.data.creditnote}
              />
              {noExcluded && (
                <p className="text-xs text-amber-700 sm:col-span-2 dark:text-amber-300">
                  Ninguna serie de facturas está marcada «No enviar a Verifactu». Créala en Holded y
                  recarga esta página.
                </p>
              )}
            </div>
          ) : null
        ) : (
          <p className="text-xs text-muted-foreground">
            Guarda la API key para poder elegir las series.
          </p>
        )}

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Copiar las facturas a Holded automáticamente
        </label>

        {data?.enabled &&
          (data.ready ? (
            <p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Activa: las nuevas facturas se copian a
              Holded.
            </p>
          ) : (
            <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Activada pero sin serie de facturas: no se
              envía nada hasta que la elijas.
            </p>
          ))}

        {data?.lastSyncAt && (
          <p className="text-xs text-muted-foreground">
            Último envío: {new Date(data.lastSyncAt).toLocaleString('es-ES')}
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
            disabled={backfill.isPending || !data?.ready}
          >
            {backfill.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Enviar pendientes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
