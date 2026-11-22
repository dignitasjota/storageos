'use client';

import {
  HEALTH_CLIENT_FACTOR_KEYS,
  HEALTH_FACTOR_LABELS,
  HEALTH_TRIAL_FACTOR_KEYS,
  type AdminPlatformHealthSettingsDto,
} from '@storageos/shared';
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { useHealthSettings, useUpdateHealthSettings } from '@/lib/admin/health-insights-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

type Draft = AdminPlatformHealthSettingsDto;

/**
 * Ajustes de Salud (pesos de los factores y aviso de caída) o de Uso (consumo
 * anómalo). Cualquiera los ve; solo el rol superadmin los cambia.
 */
export function HealthSettingsButton({ section }: { section: 'health' | 'usage' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Settings2 className="mr-1.5 size-4" /> Ajustes
      </Button>
      {open && <HealthSettingsDialog section={section} onClose={() => setOpen(false)} />}
    </>
  );
}

function HealthSettingsDialog({
  section,
  onClose,
}: {
  section: 'health' | 'usage';
  onClose: () => void;
}) {
  const settings = useHealthSettings();
  const update = useUpdateHealthSettings();
  const canEdit = useIsSuperadmin();
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = draft ?? settings.data ?? null;

  const clientSum = d ? HEALTH_CLIENT_FACTOR_KEYS.reduce((a, k) => a + d.clientWeights[k], 0) : 0;
  const trialSum = d ? HEALTH_TRIAL_FACTOR_KEYS.reduce((a, k) => a + d.trialWeights[k], 0) : 0;
  const valid = section === 'usage' || (clientSum === 100 && trialSum === 100);

  function patch(next: Partial<Draft>) {
    if (!d) return;
    setDraft({ ...d, ...next });
  }

  async function save() {
    if (!d) return;
    try {
      await update.mutateAsync(
        section === 'health'
          ? {
              clientWeights: d.clientWeights,
              trialWeights: d.trialWeights,
              dropAlertPoints: d.dropAlertPoints,
            }
          : {
              anomalyMultiplier: d.anomalyMultiplier,
              anomalyMinEmails: d.anomalyMinEmails,
              anomalyMinAiUsd: d.anomalyMinAiUsd,
              anomalyMinStorageMb: d.anomalyMinStorageMb,
            },
      );
      toast.success('Ajustes guardados.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron guardar.');
    }
  }

  const num = (v: string) => (v.trim() === '' ? 0 : Number(v));

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {section === 'health' ? 'Ajustes de Salud' : 'Ajustes del consumo anómalo'}
          </DialogTitle>
          <DialogDescription>
            {section === 'health'
              ? 'Peso de cada factor en la puntuación (en %, deben sumar 100) y cuántos puntos tiene que caer un cliente en una semana para avisar.'
              : 'Se avisa cuando un tenant consume en 30 días más de N veces su media de los 3 meses anteriores y por encima de un mínimo.'}
            {!canEdit && ' Solo el rol superadmin puede cambiarlos.'}
          </DialogDescription>
        </DialogHeader>
        {!d ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : section === 'health' ? (
          <div className="space-y-4">
            <WeightGroup
              title="Clientes"
              keys={HEALTH_CLIENT_FACTOR_KEYS}
              values={d.clientWeights}
              sum={clientSum}
              disabled={!canEdit}
              onChange={(k, v) => patch({ clientWeights: { ...d.clientWeights, [k]: v } })}
            />
            <WeightGroup
              title="Pruebas (activación)"
              keys={HEALTH_TRIAL_FACTOR_KEYS}
              values={d.trialWeights}
              sum={trialSum}
              disabled={!canEdit}
              onChange={(k, v) => patch({ trialWeights: { ...d.trialWeights, [k]: v } })}
            />
            <div className="space-y-1.5">
              <Label htmlFor="drop-points">Avisar si un cliente cae (puntos en una semana)</Label>
              <Input
                id="drop-points"
                type="number"
                min={1}
                max={100}
                disabled={!canEdit}
                value={d.dropAlertPoints}
                onChange={(e) => patch({ dropAlertPoints: num(e.target.value) })}
                className="w-28"
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              id="an-mult"
              label="Veces su media"
              value={d.anomalyMultiplier}
              step={0.5}
              disabled={!canEdit}
              onChange={(v) => patch({ anomalyMultiplier: v })}
            />
            <NumberField
              id="an-emails"
              label="Mínimo de correos en 30 días"
              value={d.anomalyMinEmails}
              disabled={!canEdit}
              onChange={(v) => patch({ anomalyMinEmails: v })}
            />
            <NumberField
              id="an-ai"
              label="Mínimo de IA en 30 días ($)"
              value={d.anomalyMinAiUsd}
              step={0.5}
              disabled={!canEdit}
              onChange={(v) => patch({ anomalyMinAiUsd: v })}
            />
            <NumberField
              id="an-storage"
              label="Mínimo de almacenamiento (MB)"
              value={d.anomalyMinStorageMb}
              disabled={!canEdit}
              onChange={(v) => patch({ anomalyMinStorageMb: v })}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {canEdit ? 'Cancelar' : 'Cerrar'}
          </Button>
          {canEdit && (
            <Button onClick={() => void save()} disabled={!d || !valid || update.isPending}>
              Guardar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WeightGroup<K extends keyof typeof HEALTH_FACTOR_LABELS>({
  title,
  keys,
  values,
  sum,
  disabled,
  onChange,
}: {
  title: string;
  keys: readonly K[];
  values: Record<K, number>;
  sum: number;
  disabled: boolean;
  onChange: (k: K, v: number) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="flex w-full items-center justify-between text-sm font-medium">
        <span>{title}</span>
        <span
          className={`text-xs tabular-nums ${sum === 100 ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400'}`}
        >
          Suman {sum} %{sum !== 100 && ' (deben sumar 100)'}
        </span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {keys.map((k) => (
          <label key={k} className="flex min-w-0 items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">{HEALTH_FACTOR_LABELS[k]}</span>
            <Input
              type="number"
              min={0}
              max={100}
              disabled={disabled}
              value={values[k]}
              onChange={(e) => onChange(k, e.target.value === '' ? 0 : Number(e.target.value))}
              className="h-8 w-20 shrink-0 text-right"
              aria-label={`Peso de ${HEALTH_FACTOR_LABELS[k]}`}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  value,
  step = 1,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  step?: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        step={step}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
    </div>
  );
}
