'use client';

import {
  earliestRentIncreaseDate,
  RENT_INCREASE_EXCLUSION_LABELS,
  RENT_INCREASE_HIGH_PCT,
  type RentIncreaseNoticePreviewDto,
  type RentIncreasePreviewDto,
  type RentIncreaseTypeValue,
} from '@storageos/shared';
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { NoticePreview } from './notice-preview';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import {
  useCreateRentIncrease,
  usePreviewRentIncrease,
  usePreviewRentIncreaseNotice,
  useRentIncreasePolicy,
} from '@/lib/rent-increases/hooks';

const STEPS = ['A quién', 'Cuánto', 'Repasar', 'El aviso'] as const;

/** Los próximos 12 días 1 a partir del primero posible. */
function firstDaysFrom(earliest: string): string[] {
  const out: string[] = [];
  const d = new Date(`${earliest}T00:00:00Z`);
  for (let i = 0; i < 12; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
  }
  return out;
}

export const monthLabel = (ymd: string) =>
  new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${ymd}T00:00:00Z`));

/**
 * Programar una subida en cuatro pasos: a quién, cuánto y desde cuándo,
 * repasar la lista (quitando a quien no se quiera subir) y ver el correo que
 * le llegará a cada inquilino antes de enviarlo.
 */
export function CreateWizard() {
  const ask = useConfirm();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const policy = useRentIncreasePolicy();
  const headerFacility = useHeaderFacilityId();
  const companyWide = useCompanyWide();
  const preview = usePreviewRentIncrease();
  const noticePreview = usePreviewRentIncreaseNotice();
  const create = useCreateRentIncrease();

  const [name, setName] = useState('');
  const [type, setType] = useState<RentIncreaseTypeValue>('percentage');
  const [value, setValue] = useState('5');
  const [minMonths, setMinMonths] = useState('6');
  const [facilityId, setFacilityId] = useState<string>('all');
  const [unitTypeId, setUnitTypeId] = useState<string>('all');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [result, setResult] = useState<RentIncreasePreviewDto | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<RentIncreaseNoticePreviewDto | null>(null);
  const [noticeFor, setNoticeFor] = useState<string | null>(null);

  const earliest = earliestRentIncreaseDate(localDateString(), policy.data?.noticeDays ?? 30);
  const dates = useMemo(() => firstDaysFrom(earliest), [earliest]);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setResult(null);
    setRemoved(new Set());
    setNotice(null);
    setFacilityId(headerFacility ?? (companyWide ? 'all' : (facilities.data?.[0]?.id ?? 'all')));
    setEffectiveDate((d) => (d && d >= earliest ? d : earliest));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const numValue = Number(String(value).replace(',', '.'));
  const selected = useMemo(
    () => (result?.contracts ?? []).filter((c) => !removed.has(c.contractId)),
    [result, removed],
  );
  const mrrDelta = selected.reduce((s, c) => s + (c.newPrice - c.oldPrice), 0);

  function buildBase() {
    return {
      increaseType: type,
      increaseValue: numValue,
      effectiveDate,
      scope: {
        minMonthsSinceSigned: Number(minMonths) || 0,
        ...(facilityId !== 'all' ? { facilityId } : {}),
        ...(unitTypeId !== 'all' ? { unitTypeId } : {}),
      },
    };
  }

  async function loadPreview(): Promise<boolean> {
    if (!(numValue > 0)) {
      toast.error(type === 'fixed' ? 'Indica cuántos euros sube.' : 'Indica el porcentaje.');
      return false;
    }
    try {
      setResult(await preview.mutateAsync(buildBase()));
      setRemoved(new Set());
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular.');
      return false;
    }
  }

  async function loadNotice(contractId: string | null) {
    const c = selected.find((x) => x.contractId === contractId) ?? selected[0];
    setNoticeFor(c?.contractId ?? null);
    try {
      setNotice(
        await noticePreview.mutateAsync({
          locale: 'es',
          ...(c
            ? {
                contractId: c.contractId,
                newPrice: c.newPrice,
                effectiveDate: c.effectiveDate ?? effectiveDate,
              }
            : { effectiveDate }),
        }),
      );
    } catch (err) {
      setNotice(null);
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo preparar el aviso.');
    }
  }

  async function next() {
    if (step === 1) {
      if (!(await loadPreview())) return;
    }
    if (step === 2) {
      if (selected.length === 0) {
        toast.error('No queda ningún contrato en la lista.');
        return;
      }
      void loadNotice(selected[0]?.contractId ?? null);
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  function toggle(id: string) {
    setRemoved((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
  }

  async function submit() {
    if (!name.trim()) {
      toast.error('Ponle un nombre a la subida.');
      return;
    }
    if (!result || selected.length === 0) return;
    const high = selected.some((c) => c.newPrice > c.oldPrice * (1 + RENT_INCREASE_HIGH_PCT / 100));
    const raised = selected.filter((c) => c.raisedThisYear).length;
    const confirmed = await ask({
      title: `¿Programar la subida y avisar a ${selected.length} inquilinos?`,
      description: [
        high ? `Hay subidas de más del ${RENT_INCREASE_HIGH_PCT} %.` : null,
        `El correo con el preaviso sale ahora y la cuota cambia el ${monthLabel(effectiveDate)}.`,
        raised > 0
          ? `${raised} ya tuvieron una subida en los últimos 12 meses: el contrato dice que la cuota se revisa una vez al año.`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Programar y avisar',
    });
    if (!confirmed) return;
    try {
      await create.mutateAsync({
        name: name.trim(),
        ...buildBase(),
        ...(removed.size > 0 ? { excludeContractIds: [...removed] } : {}),
      });
      toast.success('Subida programada. Se ha enviado el preaviso a los inquilinos.');
      setOpen(false);
      setName('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo programar.');
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-4 w-4" /> Nueva subida
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Programar una subida de precio</DialogTitle>
            <DialogDescription>
              Paso {step + 1} de {STEPS.length}: {STEPS[step]}
            </DialogDescription>
          </DialogHeader>
          <ol className="flex gap-1 text-xs" aria-label="Pasos">
            {STEPS.map((label, i) => (
              <li
                key={label}
                className={`flex-1 rounded-full px-2 py-1 text-center ${
                  i === step
                    ? 'bg-primary text-primary-foreground'
                    : i < step
                      ? 'bg-primary/15 text-foreground'
                      : 'bg-muted text-muted-foreground'
                }`}
                aria-current={i === step ? 'step' : undefined}
              >
                {i + 1}. {label}
              </li>
            ))}
          </ol>

          {step === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Elige a qué contratos se les sube. Las viviendas no entran: se actualizan en su
                aniversario (Renovaciones).
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label>Local</Label>
                  <Select value={facilityId} onValueChange={setFacilityId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {companyWide && <SelectItem value="all">Todos</SelectItem>}
                      {(facilities.data ?? []).map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Tamaño</Label>
                  <Select value={unitTypeId} onValueChange={setUnitTypeId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      {(unitTypes.data ?? [])
                        .filter((t) => t.propertyKind !== 'housing')
                        .map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ri-min">Antigüedad mínima (meses)</Label>
                  <Input
                    id="ri-min"
                    inputMode="numeric"
                    value={minMonths}
                    onChange={(e) => setMinMonths(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Cómo sube</Label>
                <Select value={type} onValueChange={(v) => setType(v as RentIncreaseTypeValue)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Un porcentaje a todos</SelectItem>
                    <SelectItem value="fixed">Unos euros al mes a todos</SelectItem>
                    <SelectItem value="to_list_price">
                      Hasta el precio de tarifa a quien paga menos
                    </SelectItem>
                  </SelectContent>
                </Select>
                {type === 'to_list_price' && (
                  <p className="text-xs text-muted-foreground">
                    Cada uno sube hasta el precio de tarifa actual de su trastero, sin pasar del
                    porcentaje que pongas. Quien ya paga la tarifa o más no entra.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="ri-value">
                    {type === 'fixed'
                      ? 'Euros al mes'
                      : type === 'to_list_price'
                        ? 'Como mucho (%)'
                        : 'Porcentaje'}
                  </Label>
                  <Input
                    id="ri-value"
                    inputMode="decimal"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Desde el</Label>
                  <Select value={effectiveDate} onValueChange={setEffectiveDate}>
                    <SelectTrigger>
                      <SelectValue placeholder="Elige el mes" />
                    </SelectTrigger>
                    <SelectContent>
                      {dates.map((d) => (
                        <SelectItem key={d} value={d}>
                          {monthLabel(d)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Siempre un día 1, con {policy.data?.noticeDays ?? 30} días de preaviso como
                    mínimo.
                  </p>
                </div>
              </div>
            </div>
          )}

          {step === 2 && result && (
            <ReviewStep
              result={result}
              removed={removed}
              onToggle={toggle}
              onToggleAll={(all) =>
                setRemoved(all ? new Set() : new Set(result.contracts.map((c) => c.contractId)))
              }
              selectedCount={selected.length}
              mrrDelta={mrrDelta}
            />
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="ri-name">Nombre de la subida</Label>
                <Input
                  id="ri-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Revisión anual 2027"
                />
                <p className="text-xs text-muted-foreground">Solo lo ve el equipo.</p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label>Ver el aviso de</Label>
                  <Select value={noticeFor ?? ''} onValueChange={(v) => void loadNotice(v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Elige un inquilino" />
                    </SelectTrigger>
                    <SelectContent>
                      {selected.slice(0, 200).map((c) => (
                        <SelectItem key={c.contractId} value={c.contractId}>
                          {c.customerName} · {c.unitCode}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <NoticePreview preview={notice} loading={noticePreview.isPending} />
              <p className="text-xs text-muted-foreground">
                Cada inquilino lo recibe con sus importes (IVA incluido), en su idioma, y lo ve en
                su área de clientes. El texto se cambia en «Texto del aviso».
              </p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={() => (step === 0 ? setOpen(false) : setStep((s) => s - 1))}
            >
              {step === 0 ? (
                'Cerrar'
              ) : (
                <>
                  <ChevronLeft className="mr-1 h-4 w-4" /> Atrás
                </>
              )}
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                onClick={() => void next()}
                disabled={preview.isPending || (step === 1 && !effectiveDate)}
              >
                {preview.isPending ? 'Calculando…' : 'Siguiente'}
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={() => void submit()}
                disabled={create.isPending || selected.length === 0 || !name.trim()}
              >
                <TrendingUp className="mr-1 h-4 w-4" />
                {create.isPending ? 'Programando…' : `Programar y avisar a ${selected.length}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReviewStep({
  result,
  removed,
  onToggle,
  onToggleAll,
  selectedCount,
  mrrDelta,
}: {
  result: RentIncreasePreviewDto;
  removed: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (all: boolean) => void;
  selectedCount: number;
  mrrDelta: number;
}) {
  const raised = result.contracts.filter(
    (c) => c.raisedThisYear && !removed.has(c.contractId),
  ).length;
  const noEmail = result.contracts.filter((c) => c.noEmail && !removed.has(c.contractId)).length;
  const firstDate = result.contracts[0]?.effectiveDate;
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-medium">{selectedCount}</span> de {result.affectedCount} contratos ·{' '}
        <span className="text-emerald-700 dark:text-emerald-400">
          +{formatEur(mrrDelta)} al mes
        </span>
        <span className="text-muted-foreground"> · desmarca a quien no quieras subir</span>
      </p>
      {raised > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {raised} ya tuvieron una subida en los últimos 12 meses. El contrato dice que la cuota se
          revisa una vez al año.
        </p>
      )}
      {noEmail > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          {noEmail} no tienen email: no les llegará el preaviso, avísales tú.
        </p>
      )}
      {result.excluded.length > 0 && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Se quedan fuera:</p>
          <ul className="list-inside list-disc space-y-0.5">
            {result.excluded.map((e) => (
              <li key={e.reason}>
                {e.count} · {RENT_INCREASE_EXCLUSION_LABELS[e.reason]}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.affectedCount === 0 ? (
        <p className="text-muted-foreground">
          Ningún contrato cumple estos criterios. Vuelve atrás y prueba con menos antigüedad, otro
          local o tamaño; los que ya tienen una subida programada no entran en otra.
        </p>
      ) : (
        <div className="rounded-md border">
          <label className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1.5 text-xs font-medium">
            <Checkbox
              checked={removed.size === 0}
              onCheckedChange={(v) => onToggleAll(v === true)}
              aria-label="Marcar todos"
            />
            Todos
          </label>
          <ul className="max-h-72 divide-y overflow-auto">
            {result.contracts.map((c) => (
              <li key={c.contractId}>
                <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-2">
                  <Checkbox
                    checked={!removed.has(c.contractId)}
                    onCheckedChange={() => onToggle(c.contractId)}
                    aria-label={`Subir a ${c.customerName}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{c.customerName}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · {c.unitCode} · {c.contractNumber}
                    </span>
                    {c.raisedThisYear && (
                      <Badge variant="outline" className="ml-2">
                        Subida este año
                      </Badge>
                    )}
                    {c.noEmail && (
                      <Badge variant="outline" className="ml-2">
                        Sin email
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs">
                    {formatEur(c.oldPrice)} → <strong>{formatEur(c.newPrice)}</strong>
                    {c.effectiveDate !== firstDate && (
                      <span className="text-muted-foreground">
                        {' '}
                        · desde {formatDate(c.effectiveDate)}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Importes sin IVA. Quien paga por adelantado cambia al empezar su siguiente periodo.
      </p>
    </div>
  );
}
