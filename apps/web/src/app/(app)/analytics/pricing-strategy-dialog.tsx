'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PricingStrategyDto } from '@storageos/shared';

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
import { usePricingStrategy, useUpdatePricingStrategy } from '@/lib/analytics/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';

type Draft = {
  targetOccupancy: string;
  maxStepPct: string;
  minDaysBetweenChanges: string;
  facilities: Record<string, string>;
  unitTypes: Record<string, { min: string; max: string }>;
};

const str = (n: number | null) => (n == null ? '' : String(n));
const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

function toDraft(s: PricingStrategyDto): Draft {
  return {
    targetOccupancy: String(s.targetOccupancy),
    maxStepPct: String(s.maxStepPct),
    minDaysBetweenChanges: String(s.minDaysBetweenChanges),
    facilities: Object.fromEntries(s.facilities.map((f) => [f.id, String(f.positioningPct)])),
    unitTypes: Object.fromEntries(
      s.unitTypes.map((t) => [t.id, { min: str(t.minPrice), max: str(t.maxPrice) }]),
    ),
  };
}

/** Botón + diálogo con la estrategia de precios del negocio. */
export function PricingStrategyButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <SlidersHorizontal className="mr-1 size-4" /> Estrategia de precios
      </Button>
      <PricingStrategyDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function PricingStrategyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data } = usePricingStrategy();
  const update = useUpdatePricingStrategy();
  const canEdit = useHasPermission('units:manage');
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (open && data) setDraft(toDraft(data));
  }, [open, data]);

  async function onSave() {
    if (!data || !draft) return;
    try {
      await update.mutateAsync({
        targetOccupancy: Number(draft.targetOccupancy),
        maxStepPct: Number(draft.maxStepPct),
        minDaysBetweenChanges: Number(draft.minDaysBetweenChanges),
        facilities: data.facilities.map((f) => ({
          id: f.id,
          positioningPct: Number(draft.facilities[f.id] ?? 0),
        })),
        unitTypes: data.unitTypes.map((t) => ({
          id: t.id,
          minPrice: num(draft.unitTypes[t.id]?.min ?? ''),
          maxPrice: num(draft.unitTypes[t.id]?.max ?? ''),
        })),
      });
      toast.success('Estrategia guardada');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Estrategia de precios</DialogTitle>
          <DialogDescription>
            El precio sugerido parte del precio de mercado de cada tamaño, se ajusta por tu
            posicionamiento y por la demanda, y respeta estos límites.
          </DialogDescription>
        </DialogHeader>

        {!draft || !data ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <fieldset disabled={!canEdit} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field
                label="Ocupación objetivo (%)"
                hint="Por encima sube el precio; por debajo lo baja."
              >
                <Input
                  inputMode="numeric"
                  value={draft.targetOccupancy}
                  onChange={(e) => setDraft({ ...draft, targetOccupancy: e.target.value })}
                />
              </Field>
              <Field label="Cambio máximo por vez (%)" hint="Con pocos datos, la mitad.">
                <Input
                  inputMode="numeric"
                  value={draft.maxStepPct}
                  onChange={(e) => setDraft({ ...draft, maxStepPct: e.target.value })}
                />
              </Field>
              <Field label="Días entre cambios" hint="No se vuelve a sugerir antes.">
                <Input
                  inputMode="numeric"
                  value={draft.minDaysBetweenChanges}
                  onChange={(e) => setDraft({ ...draft, minDaysBetweenChanges: e.target.value })}
                />
              </Field>
            </div>

            {data.facilities.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Posicionamiento por local</p>
                <p className="text-xs text-muted-foreground">
                  % frente al mercado: −5 = algo más barato, 0 = en mercado, +5 = algo más caro.
                </p>
                {data.facilities.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3">
                    <span className="text-sm">{f.name}</span>
                    <Input
                      className="w-24"
                      inputMode="numeric"
                      aria-label={`Posicionamiento de ${f.name}`}
                      value={draft.facilities[f.id] ?? '0'}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          facilities: { ...draft.facilities, [f.id]: e.target.value },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            )}

            {data.unitTypes.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Precio mínimo y máximo por tipo (€/mes)</p>
                <p className="text-xs text-muted-foreground">
                  Vacío = sin límite. Sin IVA, como el resto de tus precios.
                </p>
                {data.unitTypes.map((t) => {
                  const v = draft.unitTypes[t.id] ?? { min: '', max: '' };
                  const set = (patch: Partial<typeof v>) =>
                    setDraft({
                      ...draft,
                      unitTypes: { ...draft.unitTypes, [t.id]: { ...v, ...patch } },
                    });
                  return (
                    <div key={t.id} className="flex items-center justify-between gap-3">
                      <span className="text-sm">{t.name}</span>
                      <div className="flex gap-2">
                        <Input
                          className="w-24"
                          inputMode="decimal"
                          placeholder="Mín."
                          aria-label={`Precio mínimo de ${t.name}`}
                          value={v.min}
                          onChange={(e) => set({ min: e.target.value })}
                        />
                        <Input
                          className="w-24"
                          inputMode="decimal"
                          placeholder="Máx."
                          aria-label={`Precio máximo de ${t.name}`}
                          value={v.max}
                          onChange={(e) => set({ max: e.target.value })}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </fieldset>
        )}

        {canEdit && (
          <DialogFooter>
            <Button onClick={() => void onSave()} disabled={!draft || update.isPending}>
              Guardar
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
