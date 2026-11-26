'use client';

import {
  SEO_PROVIDER_LABELS,
  SEO_SISTRIX_DATA_TYPES,
  SEO_SISTRIX_DATA_TYPE_LABELS,
  SEO_SYNC_FREQUENCIES,
  SEO_SYNC_FREQUENCY_LABELS,
  SEO_AI_VISIBILITY_API_NOTE,
  type SeoSistrixDataType,
  type SeoSyncFrequency,
  type SeoTenantSistrixDto,
} from '@storageos/shared';
import { Info, Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDateTime } from '@/lib/format';
import { useTenantSistrixRequests } from '@/lib/seo-advanced/improvement-hooks';
import { useUpdateTenantSistrixSettings } from '@/lib/seo-advanced/sistrix-hooks';

/** La visibilidad en IA no se pide con una clave de API (mejora 15). */
export function SistrixAiVisibilityNote() {
  return (
    <p className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{SEO_AI_VISIBILITY_API_NOTE}</span>
    </p>
  );
}

/**
 * Historial de peticiones del tenant con sus créditos (mejora 15): qué consultó
 * con su clave de SISTRIX, cuándo y cuánto gastó. Las servidas de la caché no
 * gastan nada.
 */
export function TenantSistrixHistoryCard() {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const list = useTenantSistrixRequests(cursor);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Qué has consultado y cuánto ha costado</CardTitle>
        <CardDescription>
          Cada consulta a SISTRIX con tu clave y los créditos que ha gastado. Las que se sirven de
          lo ya guardado no gastan nada.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isError ? (
          <SectionError onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : !list.data?.items.length ? (
          <p className="text-sm text-muted-foreground">Aún no hay consultas.</p>
        ) : (
          <ul className="divide-y text-sm">
            {list.data.items.map((r) => (
              <li key={r.id} className="space-y-0.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">
                    {r.tool}
                    {r.view ? `/${r.view}` : ''}
                  </span>
                  <Badge
                    variant={
                      r.status === 'error' || r.status === 'quota' ? 'destructive' : 'outline'
                    }
                  >
                    {r.status === 'ok'
                      ? 'Correcta'
                      : r.status === 'cached'
                        ? 'De la caché'
                        : r.status === 'empty'
                          ? 'Sin resultados'
                          : r.status === 'quota'
                            ? 'Cuota agotada'
                            : 'Con error'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {SEO_PROVIDER_LABELS[r.provider]}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {r.credits > 0 ? `${formatCount(r.credits)} créditos` : 'sin coste'}
                  </span>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  {formatDateTime(r.createdAt)}
                  {r.createdBy ? ` · ${r.createdBy}` : ''} ·{' '}
                  {Object.entries(r.args)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(' ')}
                </p>
                {r.errorMessage && (
                  <p className="break-words text-xs text-destructive">{r.errorMessage}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          {cursors.length > 1 && (
            <Button size="sm" variant="outline" onClick={() => setCursors(cursors.slice(0, -1))}>
              Anteriores
            </Button>
          )}
          {list.data?.nextCursor && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCursors([...cursors, list.data!.nextCursor])}
            >
              Más antiguas
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Frecuencias y límites de las consultas con su clave (la ruta ya existía; faltaba la pantalla). */
export function TenantSistrixFrequenciesCard({
  settings,
  canEdit,
}: {
  settings: SeoTenantSistrixDto['settings'];
  canEdit: boolean;
}) {
  const update = useUpdateTenantSistrixSettings();
  const [freq, setFreq] = useState(settings.frequencies);
  const [perDay, setPerDay] = useState(String(settings.maxRequestsPerDay));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        frequencies: freq,
        maxRequestsPerDay: Math.max(1, Math.round(Number(perDay) || 1)),
      });
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cada cuánto se consulta</CardTitle>
        <CardDescription>
          Con tu clave de SISTRIX, cada cuánto se pide cada dato. Cuanto menos a menudo, menos
          créditos gastas. Hoy van {formatCount(settings.requestsToday)} consultas de{' '}
          {formatCount(settings.maxRequestsPerDay)}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {SEO_SISTRIX_DATA_TYPES.filter((t) => t !== 'ai_visibility').map(
              (t: SeoSistrixDataType) => (
                <div key={t} className="space-y-1">
                  <Label>{SEO_SISTRIX_DATA_TYPE_LABELS[t]}</Label>
                  <Select
                    value={freq[t]}
                    disabled={!canEdit}
                    onValueChange={(v) => setFreq({ ...freq, [t]: v as SeoSyncFrequency })}
                  >
                    <SelectTrigger aria-label={SEO_SISTRIX_DATA_TYPE_LABELS[t]}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SEO_SYNC_FREQUENCIES.map((f) => (
                        <SelectItem key={f} value={f}>
                          {SEO_SYNC_FREQUENCY_LABELS[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ),
            )}
          </div>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="tenant-per-day">Consultas al día, como mucho</Label>
            <Input
              id="tenant-per-day"
              type="number"
              min={1}
              value={perDay}
              disabled={!canEdit}
              onChange={(e) => setPerDay(e.target.value)}
            />
          </div>
          {canEdit && (
            <Button type="submit" size="sm" disabled={update.isPending}>
              Guardar
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
