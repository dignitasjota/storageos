'use client';

import {
  SEO_OPPORTUNITY_THRESHOLD_RANGES,
  SEO_WEIGHT_KEYS,
  SEO_WEIGHT_LABELS,
  type SeoOpportunityThresholdKey,
  type SeoOpportunityThresholds,
  type SeoWeights,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import {
  type OpportunityScope,
  useOpportunitySettings,
  useUpdateOpportunitySettings,
} from '@/lib/seo-advanced/opportunity-hooks';

const THRESHOLD_KEYS = Object.keys(
  SEO_OPPORTUNITY_THRESHOLD_RANGES,
) as SeoOpportunityThresholdKey[];
/** Los que se guardan como parte (0–1) y se enseñan en %. */
const RATIO_KEYS: SeoOpportunityThresholdKey[] = ['lowCtrRatio', 'lowShare'];

/** Pesos y umbrales del motor de oportunidades del proyecto. */
export function OpportunitySettingsDialog({
  scope,
  open,
  onOpenChange,
}: {
  scope: OpportunityScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useOpportunitySettings(scope, open);
  const update = useUpdateOpportunitySettings(scope);
  const confirm = useConfirm();
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [thresholds, setThresholds] = useState<Record<string, string>>({});

  const data = settings.data;
  useEffect(() => {
    if (!data || !open) return;
    setWeights(
      Object.fromEntries(
        SEO_WEIGHT_KEYS.map((k) => [k, String(Math.round(data.weights[k] * 100))]),
      ),
    );
    setThresholds(
      Object.fromEntries(
        THRESHOLD_KEYS.map((k) => [
          k,
          String(
            RATIO_KEYS.includes(k)
              ? Math.round(data.thresholds[k] * 1000) / 10
              : data.thresholds[k],
          ),
        ]),
      ),
    );
  }, [data, open]);

  const submit = async () => {
    const w = {} as SeoWeights;
    for (const k of SEO_WEIGHT_KEYS) {
      const v = Number(weights[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        toast.error(`${SEO_WEIGHT_LABELS[k]}: entre 0 y 100.`);
        return;
      }
      w[k] = v / 100;
    }
    const t = {} as SeoOpportunityThresholds;
    for (const k of THRESHOLD_KEYS) {
      const r = SEO_OPPORTUNITY_THRESHOLD_RANGES[k];
      const raw = Number(thresholds[k]);
      const v = RATIO_KEYS.includes(k) ? raw / 100 : raw;
      if (!Number.isFinite(v) || v < r.min || v > r.max || (r.integer && !Number.isInteger(v))) {
        toast.error(`${r.label}: valor fuera de rango.`);
        return;
      }
      t[k] = v;
    }
    try {
      await update.mutateAsync({ weights: w, thresholds: t });
      toast.success('Guardado. Las puntuaciones se han recalculado.');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const reset = async () => {
    const yes = await confirm({
      title: '¿Volver a los valores por defecto?',
      description:
        'Se pierden los pesos y umbrales de este proyecto y se recalculan las puntuaciones.',
      confirmLabel: 'Restaurar',
    });
    if (!yes) return;
    try {
      await update.mutateAsync({ reset: true });
      toast.success('Valores por defecto restaurados');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cómo se puntúan las oportunidades</DialogTitle>
          <DialogDescription>
            La puntuación (0–100) suma cada factor según su peso; lo que no se sabe no resta y su
            peso se reparte entre lo demás. La dificultad resta. Al guardar se recalculan.
          </DialogDescription>
        </DialogHeader>
        {settings.isError ? (
          <SectionError onRetry={() => void settings.refetch()} />
        ) : !data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Pesos (%)</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {SEO_WEIGHT_KEYS.map((k) => (
                  <div key={k} className="space-y-1">
                    <Label htmlFor={`w-${k}`}>{SEO_WEIGHT_LABELS[k]}</Label>
                    <Input
                      id={`w-${k}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      value={weights[k] ?? ''}
                      onChange={(e) => setWeights((s) => ({ ...s, [k]: e.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Por defecto {Math.round(data.defaults.weights[k] * 100)}
                    </p>
                  </div>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Umbrales</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {THRESHOLD_KEYS.map((k) => {
                  const r = SEO_OPPORTUNITY_THRESHOLD_RANGES[k];
                  const ratio = RATIO_KEYS.includes(k);
                  const def = data.defaults.thresholds[k];
                  return (
                    <div key={k} className="space-y-1">
                      <Label htmlFor={`t-${k}`}>
                        {r.label}
                        {ratio ? ' (%)' : ''}
                      </Label>
                      <Input
                        id={`t-${k}`}
                        type="number"
                        inputMode="decimal"
                        step={ratio || !r.integer ? 'any' : 1}
                        value={thresholds[k] ?? ''}
                        onChange={(e) => setThresholds((s) => ({ ...s, [k]: e.target.value }))}
                      />
                      <p className="text-xs text-muted-foreground">
                        Por defecto {ratio ? Math.round(def * 1000) / 10 : def}
                      </p>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => void reset()} disabled={!data || update.isPending}>
            Restaurar por defecto
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={!data || update.isPending}>
              {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
              Guardar
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
