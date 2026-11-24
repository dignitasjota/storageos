'use client';

import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_MANUAL_LOST_REASONS,
  proposeRecoverOn,
  SALES_RECOVER_MONTHS_DEFAULT,
  type PlatformLeadLostReason,
  type SalesAccountDto,
} from '@storageos/shared';
import { Archive, Ban, Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { addDaysIso, errorText, Field, todayInSpain } from '@/components/admin/sales/common';
import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useSalesArchive, useSalesMe, useSalesRecover } from '@/lib/admin/sales-hooks';
import { formatDate } from '@/lib/format';

export type ManualReason = Exclude<PlatformLeadLostReason, 'churned'>;

/** Lo que pide el «No interesado» (una ficha o en lote). */
export interface ArchiveFormValue {
  reasonCode: ManualReason | '';
  reason: string;
  /** null = sin elegir: la que toca por el motivo. */
  recoverOn: string | null;
  doNotContact: boolean;
}

export const EMPTY_ARCHIVE: ArchiveFormValue = {
  reasonCode: '',
  reason: '',
  recoverOn: null,
  doNotContact: false,
};

/** Fecha propuesta por el motivo (con los plazos de Reglas del equipo). */
export function useProposedRecoverOn() {
  const me = useSalesMe();
  const months = me.data?.recoverMonths ?? SALES_RECOVER_MONTHS_DEFAULT;
  return (reason: PlatformLeadLostReason) => proposeRecoverOn(todayInSpain(), reason, months);
}

/** Lo que se envía al servidor (sin fecha elegida, la propone él). */
export function archivePayload(v: ArchiveFormValue) {
  return {
    reasonCode: v.reasonCode as ManualReason,
    ...(v.reason.trim() ? { reason: v.reason.trim() } : {}),
    ...(v.doNotContact ? { doNotContact: true } : v.recoverOn ? { recoverOn: v.recoverOn } : {}),
  };
}

/** Motivo, detalle, fecha de volver a intentarlo (propuesta y editable) y «No volver a contactar». */
export function ArchiveFields({
  value,
  onChange,
  idPrefix = 'ar',
}: {
  value: ArchiveFormValue;
  onChange: (v: ArchiveFormValue) => void;
  idPrefix?: string;
}) {
  const propose = useProposedRecoverOn();
  const proposed = value.reasonCode ? propose(value.reasonCode) : null;
  const date = value.recoverOn ?? proposed;
  return (
    <div className="space-y-3">
      <Field label="Motivo">
        <Select
          value={value.reasonCode}
          onValueChange={(v) =>
            onChange({ ...value, reasonCode: v as ManualReason, recoverOn: null })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Elige el motivo" />
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
      <Field id={`${idPrefix}-reason`} label="Detalle (opcional)">
        <Textarea
          id={`${idPrefix}-reason`}
          rows={2}
          value={value.reason}
          maxLength={1000}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
        />
      </Field>
      {!value.doNotContact && (
        <Field
          label="Volver a intentarlo el"
          hint={
            value.reasonCode
              ? value.recoverOn
                ? 'La fecha que has elegido.'
                : 'Propuesta según el motivo; puedes cambiarla.'
              : 'Elige el motivo y te proponemos la fecha.'
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <DateSelect
              value={date ?? undefined}
              onChange={(v) => {
                if (!v) return;
                // Como pronto, mañana.
                const tomorrow = addDaysIso(todayInSpain(), 1);
                onChange({ ...value, recoverOn: v < tomorrow ? tomorrow : v });
              }}
              future
            />
            {value.recoverOn && proposed && value.recoverOn !== proposed && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange({ ...value, recoverOn: null })}
              >
                Volver a la propuesta
              </Button>
            )}
          </div>
        </Field>
      )}
      <div className="flex items-start gap-2 rounded-md border p-3">
        <Checkbox
          id={`${idPrefix}-dnc`}
          checked={value.doNotContact}
          onCheckedChange={(c) => onChange({ ...value, doNotContact: c === true })}
          className="mt-0.5"
        />
        <div className="space-y-0.5">
          <Label htmlFor={`${idPrefix}-dnc`} className="text-sm">
            No volver a contactar
          </Label>
          <p className="text-xs text-muted-foreground">
            Sin fecha, sin recordatorios ni correos (tampoco secuencias ni cadencias).
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Aviso de la ficha de un archivado: por qué, hasta cuándo, y «Recuperar»,
 * cambiar la fecha o marcar «No volver a contactar».
 */
export function ArchiveBanner({ account }: { account: SalesAccountDto }) {
  const lead = account.lead;
  const recover = useSalesRecover(lead.id);
  const archive = useSalesArchive(lead.id);
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState<string | undefined>(lead.salesRecoverOn ?? undefined);
  if (!lead.salesArchivedAt) return null;
  const reason = lead.lostReasonCode ? PLATFORM_LEAD_LOST_REASON_LABELS[lead.lostReasonCode] : null;
  const due = !!lead.salesRecoverOn && lead.salesRecoverOn <= todayInSpain();
  const churned = lead.lostReasonCode === 'churned';

  async function run(p: Promise<unknown>, ok: string) {
    try {
      await p;
      toast.success(ok);
      setEditing(false);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card className={due ? 'border-violet-300 dark:border-violet-800' : undefined}>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start gap-3">
          {lead.doNotContact ? (
            <Ban className="mt-0.5 size-5 shrink-0 text-destructive" />
          ) : (
            <Archive className="mt-0.5 size-5 shrink-0 text-violet-600 dark:text-violet-400" />
          )}
          <div className="min-w-0 space-y-1 text-sm">
            <p className="font-medium">
              {lead.doNotContact
                ? 'Archivado: no volver a contactar'
                : due
                  ? 'Para recuperar: ya toca volver a intentarlo'
                  : churned
                    ? 'Se dio de baja: archivado para recuperarlo'
                    : 'Archivado: no interesado'}
            </p>
            <p className="text-muted-foreground">
              {[
                reason,
                lead.lostReason,
                `desde el ${formatDate(lead.salesArchivedAt)}`,
                !lead.doNotContact && lead.salesRecoverOn
                  ? `volver a intentarlo el ${formatDate(lead.salesRecoverOn)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {churned && (
              <p className="text-xs text-muted-foreground">
                Si vuelve a contratar, cobras la mitad de la comisión (venta y cuota).
              </p>
            )}
          </div>
        </div>
        {editing && !lead.doNotContact && (
          <div className="flex flex-wrap items-center gap-2">
            <DateSelect value={date} onChange={setDate} future />
            <Button
              size="sm"
              disabled={!date || archive.isPending}
              onClick={() => void run(archive.mutateAsync({ recoverOn: date }), 'Fecha cambiada.')}
            >
              {archive.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Guardar fecha
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={recover.isPending}
            onClick={() =>
              void run(recover.mutateAsync(undefined), 'Recuperado: vuelve a tu cartera.')
            }
          >
            {recover.isPending ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <RotateCcw className="mr-1.5 size-4" />
            )}
            Recuperar
          </Button>
          {!lead.doNotContact && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Cambiar la fecha
            </Button>
          )}
          {lead.doNotContact ? (
            <Button
              size="sm"
              variant="outline"
              disabled={archive.isPending}
              onClick={() =>
                void run(
                  archive.mutateAsync({ doNotContact: false }),
                  'Vuelve a tener fecha para intentarlo.',
                )
              }
            >
              Quitar «No volver a contactar»
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={archive.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: 'No volver a contactar',
                  description:
                    'Se queda archivado sin fecha: sin recordatorios, correos, secuencias ni cadencias.',
                  confirmLabel: 'No volver a contactar',
                  destructive: true,
                });
                if (ok) {
                  void run(archive.mutateAsync({ doNotContact: true }), 'Marcado.');
                }
              }}
            >
              No volver a contactar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
