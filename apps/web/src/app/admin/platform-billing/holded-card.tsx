'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  useBackfillPlatformHolded,
  usePlatformHolded,
  usePlatformHoldedReview,
  usePlatformHoldedSeries,
  useResolvePlatformHoldedReview,
  useTestPlatformHolded,
  useUpdatePlatformHolded,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const NONE = '__none__';

/**
 * Copia contable en Holded de las facturas de suscripción. La app las emite;
 * Holded solo las contabiliza, en una serie marcada «No enviar a Verifactu».
 * Desactivada hasta que se contrate Holded.
 */
export function PlatformHoldedCard() {
  const { data } = usePlatformHolded();
  const series = usePlatformHoldedSeries(!!data?.hasApiKey);
  const update = useUpdatePlatformHolded();
  const test = useTestPlatformHolded();
  const backfill = useBackfillPlatformHolded();
  const review = usePlatformHoldedReview((data?.reviewCount ?? 0) > 0);
  const resolve = useResolvePlatformHoldedReview();

  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [creditSeriesId, setCreditSeriesId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  if (data && !initialized) {
    setEnabled(data.enabled);
    setSeriesId(data.invoiceSeriesId);
    setCreditSeriesId(data.creditNoteSeriesId);
    setInitialized(true);
  }
  if (!data) return null;

  const err = (e: unknown, fallback: string) =>
    toast.error(e instanceof ApiError ? e.body.message : fallback);

  async function save() {
    try {
      await update.mutateAsync({
        enabled,
        ...(apiKey ? { apiKey } : {}),
        ...(data?.hasApiKey
          ? { invoiceSeriesId: seriesId, creditNoteSeriesId: creditSeriesId }
          : {}),
      });
      setApiKey('');
      toast.success('Copia en Holded guardada.');
    } catch (e) {
      err(e, 'No se pudo guardar.');
    }
  }

  async function runTest() {
    const r = await test.mutateAsync();
    if (r.ok) toast.success(r.message);
    else toast.error(r.message);
  }

  async function resolveItem(
    invoiceId: string,
    kind: 'invoice' | 'credit_note' | 'payment',
    action: 'retry' | 'already_in_holded',
  ) {
    let holdedDocumentId: string | undefined;
    if (action === 'already_in_holded' && kind !== 'payment') {
      holdedDocumentId = window.prompt('Id del documento en Holded')?.trim() || undefined;
      if (!holdedDocumentId) return;
    }
    try {
      await resolve.mutateAsync({
        invoiceId,
        input: { kind, action, ...(holdedDocumentId ? { holdedDocumentId } : {}) },
      });
      toast.success(action === 'retry' ? 'Se volverá a enviar.' : 'Marcado como copiado.');
    } catch (e) {
      err(e, 'No se pudo resolver.');
    }
  }

  async function runBackfill() {
    try {
      const r = await backfill.mutateAsync();
      toast.success(`${r.synced} factura(s) copiada(s) a Holded.`);
    } catch (e) {
      err(e, 'No se pudo enviar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Copia en Holded (opcional)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Si contratas Holded, cada factura de suscripción se copia allí (aprobada y con su cobro),
          y sus rectificativas como rectificativas de Holded, para llevar la contabilidad. Las
          facturas se siguen emitiendo aquí. Mientras no la actives, no se envía nada.
        </p>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          En Holded, crea una serie de facturas solo para las suscripciones (p. ej. «SUS-») y
          márcala
          <strong> «No enviar a Verifactu»</strong>; si no, quedarían registradas dos veces en la
          AEAT. Usa una serie distinta de la de tu negocio de trasteros.
        </div>
        <div className="space-y-1">
          <Label>API key de Holded</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data.hasApiKey ? '•••••••• (guardada)' : 'pat_…'}
          />
        </div>
        {data.hasApiKey &&
          (series.data ? (
            <div className="space-y-1">
              <div className="space-y-1">
                <Label>Serie de facturas en Holded</Label>
                <Select
                  value={seriesId ?? NONE}
                  onValueChange={(v) => setSeriesId(v === NONE ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Elige una serie" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sin elegir</SelectItem>
                    {series.data.invoice.map((s) => (
                      <SelectItem key={s.id} value={s.id} disabled={!s.verifactuExcluded}>
                        {s.name} ({s.format})
                        {s.verifactuExcluded ? '' : ' — se envía a Verifactu, no válida'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 pt-2">
                <Label>Serie de rectificativas en Holded</Label>
                <Select
                  value={creditSeriesId ?? NONE}
                  onValueChange={(v) => setCreditSeriesId(v === NONE ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Elige una serie" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sin elegir</SelectItem>
                    {series.data.creditnote.map((s) => (
                      <SelectItem key={s.id} value={s.id} disabled={!s.verifactuExcluded}>
                        {s.name} ({s.format})
                        {s.verifactuExcluded ? '' : ' — se envía a Verifactu, no válida'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Para copiar las rectificativas de suscripción (abonos y sustituciones).
                </p>
              </div>
            </div>
          ) : series.error ? (
            <p className="text-xs text-destructive">
              No se pudieron leer las series:{' '}
              {series.error instanceof ApiError ? series.error.body.message : 'error'}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Cargando las series de Holded…</p>
          ))}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Copiar las facturas de suscripción a Holded
        </label>
        <p className="text-xs text-muted-foreground">
          {data.ready
            ? `Activa. Pendientes de copiar: ${data.pendingCount}.`
            : data.enabled
              ? 'Activada pero sin serie elegida: no se envía nada.'
              : 'Desactivada.'}
          {data.lastSyncAt &&
            ` Último envío: ${new Date(data.lastSyncAt).toLocaleString('es-ES')}.`}
        </p>
        {data.lastError && (
          <p className="text-xs text-destructive">Último error: {data.lastError}</p>
        )}
        {data.reviewCount > 0 && (
          <div className="space-y-2 rounded-md border border-amber-300 p-2 dark:border-amber-800">
            <p className="text-sm font-medium">Para revisar en Holded ({data.reviewCount})</p>
            <p className="text-xs text-muted-foreground">
              Holded no respondió a estos envíos y pudieron crearse. Compruébalo en Holded: si no
              están, reenvíalos; si están, márcalos como copiados.
            </p>
            {(review.data ?? []).map((r) => (
              <div
                key={`${r.invoiceId}-${r.kind}`}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="font-mono">{r.fullNumber}</span>
                <span className="text-muted-foreground">
                  {r.kind === 'payment'
                    ? 'cobro'
                    : r.kind === 'credit_note'
                      ? 'anulación de la original'
                      : 'factura'}{' '}
                  · {r.total.toFixed(2)} €
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolve.isPending}
                  onClick={() => void resolveItem(r.invoiceId, r.kind, 'retry')}
                >
                  No está: reenviar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={resolve.isPending}
                  onClick={() => void resolveItem(r.invoiceId, r.kind, 'already_in_holded')}
                >
                  Ya está en Holded
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} disabled={update.isPending}>
            Guardar
          </Button>
          <Button
            variant="outline"
            onClick={() => void runTest()}
            disabled={test.isPending || !data.hasApiKey}
          >
            Probar conexión
          </Button>
          <Button
            variant="ghost"
            onClick={() => void runBackfill()}
            disabled={backfill.isPending || !data.ready || data.pendingCount === 0}
          >
            Enviar pendientes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
