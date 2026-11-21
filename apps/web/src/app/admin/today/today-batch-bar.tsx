'use client';

import { pluralEs, type AdminTodayBatchResultDto, type TodayBatchInput } from '@storageos/shared';
import { toast } from 'sonner';

import type { SnoozeTarget } from './today-rows';

import { Button } from '@/components/ui/button';
import { useTodayBatch } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

const ASSIGNABLE = new Set(['ticket', 'contact']);
const REMINDABLE = new Set(['past_due', 'payment_failure']);

/** Resultado de una acción en lote: cuántos se hicieron y cuáles fallaron. */
export function reportBatch(verb: string, result: AdminTodayBatchResultDto): void {
  if (result.failed.length === 0) {
    toast.success(`${verb}: ${result.done}.`);
    return;
  }
  const detail = result.failed
    .slice(0, 5)
    .map((f) => `${f.label}: ${f.message}`)
    .join(' · ');
  const more = result.failed.length > 5 ? ` · y ${result.failed.length - 5} más` : '';
  toast.warning(
    `${verb}: ${result.done}. No se pudo con ${pluralEs(result.failed.length, 'aviso', 'avisos')}: ${detail}${more}`,
  );
}

/** Barra de acciones sobre los avisos elegidos con sus casillas. */
export function TodayBatchBar({
  selected,
  onClear,
}: {
  selected: SnoozeTarget[];
  onClear: () => void;
}) {
  const batch = useTodayBatch();
  const isSuperadmin = useIsSuperadmin();
  if (selected.length === 0) return null;
  const assignable = selected.filter((s) => ASSIGNABLE.has(s.kind));
  const remindable = selected.filter((s) => REMINDABLE.has(s.kind));

  function run(input: TodayBatchInput, verb: string) {
    batch.mutate(input, {
      onSuccess: (result) => {
        reportBatch(verb, result);
        onClear();
      },
      onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
    });
  }
  const items = (list: SnoozeTarget[]) =>
    list.map(({ kind, ref, label }) => ({ kind, ref, label }));

  return (
    <div
      role="region"
      aria-label="Acciones sobre los avisos elegidos"
      className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 shadow-lg"
    >
      <span className="text-sm font-medium">
        {pluralEs(selected.length, 'aviso elegido', 'avisos elegidos')}
      </span>
      <div className="flex flex-wrap gap-2">
        {[7, 30].map((days) => (
          <Button
            key={days}
            size="sm"
            variant="outline"
            disabled={batch.isPending}
            onClick={() =>
              run({ action: 'snooze', days, items: items(selected) }, `Apartados ${days} días`)
            }
          >
            Apartar {days} días
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={batch.isPending || assignable.length === 0}
          title={assignable.length === 0 ? 'Solo se asignan tickets y leads' : undefined}
          onClick={() => run({ action: 'assign', items: items(assignable) }, 'Asignados a ti')}
        >
          Asignarme{assignable.length > 0 ? ` (${assignable.length})` : ''}
        </Button>
        {isSuperadmin && (
          <Button
            size="sm"
            variant="outline"
            disabled={batch.isPending || remindable.length === 0}
            title={remindable.length === 0 ? 'Solo se recuerdan los pagos pendientes' : undefined}
            onClick={() =>
              run({ action: 'remind', items: items(remindable) }, 'Recordatorios enviados')
            }
          >
            Recordar el pago{remindable.length > 0 ? ` (${remindable.length})` : ''}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClear}>
          Quitar la selección
        </Button>
      </div>
    </div>
  );
}
