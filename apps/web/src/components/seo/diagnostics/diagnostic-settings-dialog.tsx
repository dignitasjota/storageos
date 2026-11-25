'use client';

import {
  SEO_CANNIBALIZATION_THRESHOLD_RANGES,
  type SeoCannibalizationThresholdKey,
  type SeoCannibalizationThresholds,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  type DiagnosticScope,
  useDiagnosticSettings,
  useUpdateDiagnosticSettings,
} from '@/lib/seo-advanced/diagnostic-hooks';

const KEYS = Object.keys(SEO_CANNIBALIZATION_THRESHOLD_RANGES) as SeoCannibalizationThresholdKey[];
/** Los que son una parte (0–1) se enseñan en %. */
const SHARE_KEYS = new Set<SeoCannibalizationThresholdKey>(['minSecondShare', 'homeLowShare']);

/** Umbrales de canibalización y reglas de indexación del proyecto. */
export function DiagnosticSettingsDialog({
  scope,
  open,
  onOpenChange,
}: {
  scope: DiagnosticScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const confirm = useConfirm();
  const settings = useDiagnosticSettings(scope, open);
  const update = useUpdateDiagnosticSettings(scope);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rules, setRules] = useState('');

  const data = settings.data;
  useEffect(() => {
    if (!data || !open) return;
    setValues(
      Object.fromEntries(
        KEYS.map((k) => [
          k,
          String(
            SHARE_KEYS.has(k) ? Math.round(data.cannibalization[k] * 100) : data.cannibalization[k],
          ),
        ]),
      ),
    );
    setRules(data.indexRules.join('\n'));
  }, [data, open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cannibalization = Object.fromEntries(
      KEYS.map((k) => {
        const n = Number(values[k]);
        return [k, SHARE_KEYS.has(k) ? n / 100 : n];
      }),
    ) as SeoCannibalizationThresholds;
    const list = rules
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    try {
      await update.mutateAsync({ cannibalization, indexRules: list });
      toast.success('Ajustes guardados y diagnóstico recalculado');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const reset = async () => {
    const yes = await confirm({
      title: '¿Volver a los ajustes por defecto?',
      description: 'Se pierden tus umbrales y tus reglas de indexación.',
      confirmLabel: 'Restaurar',
    });
    if (!yes) return;
    try {
      await update.mutateAsync({ reset: true });
      toast.success('Ajustes por defecto');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ajustes del diagnóstico</DialogTitle>
          <DialogDescription>
            Cuándo se marca una búsqueda como canibalizada y qué páginas no deberían estar en
            Google. Al guardar se vuelve a calcular.
          </DialogDescription>
        </DialogHeader>
        {settings.isError ? (
          <SectionError onRetry={() => void settings.refetch()} />
        ) : !data ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-5">
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Canibalización</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {KEYS.map((k) => {
                  const r = SEO_CANNIBALIZATION_THRESHOLD_RANGES[k];
                  const share = SHARE_KEYS.has(k);
                  return (
                    <div key={k} className="space-y-1">
                      <Label htmlFor={`diag-${k}`}>
                        {r.label}
                        {share ? ' (%)' : ''}
                      </Label>
                      <Input
                        id={`diag-${k}`}
                        type="number"
                        inputMode="decimal"
                        min={share ? r.min * 100 : r.min}
                        max={share ? r.max * 100 : r.max}
                        step={share ? 1 : r.integer ? 1 : 0.01}
                        value={values[k] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="space-y-2">
              <Label htmlFor="diag-rules">
                Páginas que no deberían estar en Google (una por línea)
              </Label>
              <Textarea
                id="diag-rules"
                rows={8}
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                <code>/ruta</code> = esa ruta y lo que cuelga de ella · <code>?param</code> = con
                ese parámetro (<code>?token=</code> exacto, <code>?utm_</code> por el principio,{' '}
                <code>?</code> cualquiera) · <code>*texto*</code> = que contenga. Por defecto vienen
                las rutas que la propia web ya marca como no indexables (acceso, área de clientes,
                panel, firma, pago…).
                {data.customIndexRules ? ' Ahora usas tus propias reglas.' : ''}
              </p>
            </section>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => void reset()}>
                Restaurar por defecto
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
                  Guardar
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
