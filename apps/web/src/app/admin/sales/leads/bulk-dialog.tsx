'use client';

import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_MANUAL_LOST_REASONS,
  PLATFORM_LEAD_MANUAL_STAGES,
  PLATFORM_LEAD_STAGE_LABELS,
  type SalesBulkLeadAction,
  type SalesBulkLeadResultDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { addDaysIso, errorText, Field, todayInSpain } from '@/components/admin/sales/common';
import { DateSelect } from '@/components/month-year-select';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useSalesBulk, useSalesCadences } from '@/lib/admin/sales-hooks';

export type BulkKind = SalesBulkLeadAction['type'];

const TITLES: Record<BulkKind, string> = {
  followup: 'Programar un seguimiento',
  cadence: 'Meter en una cadencia',
  move: 'Cambiar de fase',
  lose: 'Marcar como no interesado',
};

/** La misma acción a los prospectos elegidos; dice cuáles no se han podido. */
export function BulkDialog({
  kind,
  leadIds,
  onClose,
  onDone,
}: {
  kind: BulkKind | null;
  leadIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const run = useSalesBulk();
  const cadences = useSalesCadences();
  const today = todayInSpain();
  const [title, setTitle] = useState('Volver a llamar');
  const [dueDate, setDueDate] = useState(addDaysIso(today, 1));
  const [note, setNote] = useState('');
  const [cadenceId, setCadenceId] = useState('');
  const [status, setStatus] = useState<(typeof PLATFORM_LEAD_MANUAL_STAGES)[number]>('contacted');
  const [reasonCode, setReasonCode] =
    useState<(typeof PLATFORM_LEAD_MANUAL_LOST_REASONS)[number]>('not_now');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<SalesBulkLeadResultDto | null>(null);

  function close() {
    setResult(null);
    onClose();
  }

  function action(): SalesBulkLeadAction | null {
    switch (kind) {
      case 'followup':
        return title.trim().length >= 2 && dueDate
          ? {
              type: 'followup',
              title: title.trim(),
              dueDate,
              ...(note.trim() ? { note: note.trim() } : {}),
            }
          : null;
      case 'cadence':
        return cadenceId ? { type: 'cadence', cadenceId } : null;
      case 'move':
        return { type: 'move', status };
      case 'lose':
        return {
          type: 'lose',
          reasonCode,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        };
      default:
        return null;
    }
  }

  async function submit() {
    const a = action();
    if (!a) return;
    try {
      const res = await run.mutateAsync({ leadIds, action: a });
      if (res.failed.length === 0) {
        toast.success(
          res.done === 1 ? 'Hecho en 1 prospecto.' : `Hecho en ${res.done} prospectos.`,
        );
        onDone();
        close();
      } else {
        setResult(res);
        onDone();
      }
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const activeCadences = (cadences.data ?? []).filter((c) => c.isActive);
  const n = leadIds.length;

  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{kind ? TITLES[kind] : ''}</DialogTitle>
          <DialogDescription>{n === 1 ? 'A 1 prospecto.' : `A ${n} prospectos.`}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-2 text-sm">
            <p>
              Hecho en {result.done}. No se ha podido en {result.failed.length}:
            </p>
            <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
              {result.failed.map((f) => (
                <li key={f.leadId}>
                  <span className="font-medium">{f.name ?? 'No es de tu cartera'}</span>
                  {f.name ? ` — ${f.message}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-3">
            {kind === 'followup' && (
              <>
                <Field id="bulk-title" label="Qué hay que hacer">
                  <Input
                    id="bulk-title"
                    maxLength={200}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
                <Field label="Cuándo">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap gap-1">
                      {[1, 3, 7, 14].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDueDate(addDaysIso(today, d))}
                          className="rounded border px-2 py-1 text-xs data-[on=true]:border-primary data-[on=true]:text-primary"
                          data-on={dueDate === addDaysIso(today, d)}
                        >
                          {d === 1 ? 'Mañana' : `${d} días`}
                        </button>
                      ))}
                    </div>
                    <DateSelect value={dueDate} onChange={(v) => setDueDate(v ?? '')} future />
                  </div>
                </Field>
                <Field id="bulk-note" label="Nota (opcional)">
                  <Textarea
                    id="bulk-note"
                    rows={2}
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
              </>
            )}
            {kind === 'cadence' && (
              <Field label="Cadencia">
                {activeCadences.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {cadences.isLoading ? 'Cargando…' : 'La dirección aún no ha creado cadencias.'}
                  </p>
                ) : (
                  <Select value={cadenceId} onValueChange={setCadenceId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Elige una cadencia" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeCadences.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.steps.length} pasos
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}
            {kind === 'move' && (
              <Field label="Pasan a">
                <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORM_LEAD_MANUAL_STAGES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {PLATFORM_LEAD_STAGE_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {kind === 'lose' && (
              <>
                <Field label="Motivo">
                  <Select
                    value={reasonCode}
                    onValueChange={(v) => setReasonCode(v as typeof reasonCode)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLATFORM_LEAD_MANUAL_LOST_REASONS.map((r) => (
                        <SelectItem key={r} value={r}>
                          {PLATFORM_LEAD_LOST_REASON_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field id="bulk-reason" label="Detalle (opcional)">
                  <Textarea
                    id="bulk-reason"
                    rows={2}
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Salen de tus prospectos activos (fase «Perdido») y se cierran sus seguimientos.
                </p>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Cerrar</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancelar
              </Button>
              <Button disabled={!action() || run.isPending} onClick={() => void submit()}>
                {run.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Aplicar
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
