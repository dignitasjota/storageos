'use client';

import {
  earliestRentIncreaseDate,
  RENT_INCREASE_EXCLUSION_LABELS,
  RENT_INCREASE_HIGH_PCT,
  RENT_INCREASE_SKIP_LABELS,
  type RentIncreaseDto,
  type RentIncreaseItemDto,
  type RentIncreasePreviewDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Calculator, CheckCircle2, Plus, TrendingUp, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDate, formatEur } from '@/lib/format';
import {
  useApplyRentIncrease,
  useCancelRentIncrease,
  useCreateRentIncrease,
  usePreviewRentIncrease,
  useRentIncrease,
  useRentIncreasePolicy,
  useRentIncreases,
  useUpdateRentIncreasePolicy,
} from '@/lib/rent-increases/hooks';

const STATUS: Record<
  RentIncreaseDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  scheduled: { label: 'Programada', variant: 'secondary' },
  applied: { label: 'Aplicada', variant: 'default' },
  cancelled: { label: 'Cancelada', variant: 'outline' },
};

const NOTICE: Record<NonNullable<RentIncreaseItemDto['noticeStatus']>, string> = {
  sent: 'Avisado',
  no_email: 'Sin email: avísale tú',
  failed: 'No se pudo enviar',
};

const increaseLabel = (r: Pick<RentIncreaseDto, 'increaseType' | 'increaseValue'>) =>
  r.increaseType === 'percentage' ? `+${r.increaseValue} %` : `+${formatEur(r.increaseValue)}`;

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

const monthLabel = (ymd: string) =>
  new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${ymd}T00:00:00Z`));

export default function RentIncreasesPage() {
  const ask = useConfirm();
  const list = useRentIncreases();
  const apply = useApplyRentIncrease();
  const cancel = useCancelRentIncrease();
  const canManage = useHasPermission('contracts:manage');
  const companyWide = useCompanyWide();
  const [detailId, setDetailId] = useState<string | null>(null);
  const today = localDateString();

  async function handleApply(r: RentIncreaseDto) {
    if (
      !(await ask({
        title: '¿Aplicar ya lo que ha llegado a su fecha?',
        description: 'Solo se suben los contratos cuya fecha avisada ya ha llegado.',
        confirmLabel: 'Aplicar',
      }))
    )
      return;
    try {
      const res = await apply.mutateAsync(r.id);
      toast.success(`Cuota subida a ${res.appliedCount} contratos.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo aplicar.');
    }
  }
  async function handleCancel(r: RentIncreaseDto) {
    if (
      !(await ask({
        title: `¿Cancelar «${r.name}»?`,
        description: r.noticeSent
          ? 'A los inquilinos avisados les llega un correo diciendo que la subida queda anulada. Lo que ya se haya aplicado no cambia.'
          : 'Lo que ya se haya aplicado no cambia.',
        confirmLabel: 'Cancelar la subida',
        destructive: true,
      }))
    )
      return;
    try {
      await cancel.mutateAsync(r.id);
      toast.success('Subida cancelada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar.');
    }
  }

  const columns: ColumnDef<RentIncreaseDto>[] = [
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    { id: 'increase', header: 'Subida', cell: ({ row }) => increaseLabel(row.original) },
    { accessorKey: 'affectedCount', header: 'Contratos' },
    {
      accessorKey: 'mrrDelta',
      header: 'Más al mes',
      cell: ({ row }) => (
        <span className="text-emerald-700 dark:text-emerald-400">
          +{formatEur(row.original.mrrDelta)}
        </span>
      ),
    },
    {
      accessorKey: 'effectiveDate',
      header: 'Desde',
      cell: ({ row }) => formatDate(row.original.effectiveDate),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS[row.original.status];
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      meta: { mobileLabel: '' },
      cell: ({ row }) =>
        canManage && row.original.status === 'scheduled' ? (
          <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
            {row.original.effectiveDate <= today && (
              <Button variant="outline" size="sm" onClick={() => void handleApply(row.original)}>
                <CheckCircle2 className="mr-1 h-4 w-4" /> Aplicar ahora
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void handleCancel(row.original)}>
              <XCircle className="mr-1 h-4 w-4" /> Cancelar
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Subidas de precio</h1>
        <p className="text-sm text-muted-foreground">
          Sube la cuota a los inquilinos actuales con su preaviso: el correo sale al programarla y
          la cuota cambia sola el día 1 que elijas, antes de facturar ese mes.
        </p>
      </div>

      {canManage && companyWide && <PolicyCard />}

      {list.isError ? (
        <Card>
          <SectionError onRetry={() => void list.refetch()} />
        </Card>
      ) : (
        <DataTable
          onRowClick={(r) => setDetailId(r.id)}
          columns={columns}
          data={list.data ?? []}
          isLoading={list.isLoading}
          searchPlaceholder="Buscar subida..."
          guide="precios"
          emptyText="Sube la cuota a los inquilinos actuales con su preaviso, por antigüedad, local o tamaño."
          toolbarRight={canManage ? <CreateDialog /> : null}
        />
      )}

      <DetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function CreateDialog() {
  const ask = useConfirm();
  const [open, setOpen] = useState(false);
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const policy = useRentIncreasePolicy();
  const headerFacility = useHeaderFacilityId();
  const companyWide = useCompanyWide();
  const preview = usePreviewRentIncrease();
  const create = useCreateRentIncrease();

  const [name, setName] = useState('');
  const [type, setType] = useState<'percentage' | 'fixed'>('percentage');
  const [value, setValue] = useState('5');
  const [minMonths, setMinMonths] = useState('6');
  const [facilityId, setFacilityId] = useState<string>('all');
  const [unitTypeId, setUnitTypeId] = useState<string>('all');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [result, setResult] = useState<RentIncreasePreviewDto | null>(null);

  const earliest = earliestRentIncreaseDate(localDateString(), policy.data?.noticeDays ?? 30);
  const dates = useMemo(() => firstDaysFrom(earliest), [earliest]);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setFacilityId(headerFacility ?? (companyWide ? 'all' : (facilities.data?.[0]?.id ?? 'all')));
    setEffectiveDate((d) => (d && d >= earliest ? d : earliest));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reset = () => setResult(null);
  const numValue = Number(String(value).replace(',', '.'));

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

  async function calc() {
    if (!(numValue > 0)) {
      toast.error('Indica cuánto sube.');
      return;
    }
    try {
      setResult(await preview.mutateAsync(buildBase()));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular.');
    }
  }

  async function submit() {
    if (!name.trim()) {
      toast.error('Ponle un nombre.');
      return;
    }
    if (!result || result.affectedCount === 0) return;
    const high =
      type === 'percentage'
        ? numValue > RENT_INCREASE_HIGH_PCT
        : result.contracts.some(
            (c) => c.newPrice > c.oldPrice * (1 + RENT_INCREASE_HIGH_PCT / 100),
          );
    const confirmed = await ask({
      title: `¿Programar la subida y avisar a ${result.affectedCount} inquilinos?`,
      description: [
        high ? `Es una subida grande (más del ${RENT_INCREASE_HIGH_PCT} %).` : null,
        `El correo con el preaviso sale ahora y la cuota cambia el ${monthLabel(effectiveDate)}.`,
        result.raisedThisYear > 0
          ? `${result.raisedThisYear} ya tuvieron una subida en los últimos 12 meses: el contrato dice que la cuota se revisa una vez al año.`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Programar y avisar',
    });
    if (!confirmed) return;
    try {
      await create.mutateAsync({ name: name.trim(), ...buildBase() });
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
              Empieza siempre un día 1, con {policy.data?.noticeDays ?? 30} días de preaviso como
              mínimo. Las viviendas no entran: se actualizan en su aniversario (Renovaciones).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ri-name">Nombre</Label>
              <Input
                id="ri-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Revisión anual 2027"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>Tipo</Label>
                <Select
                  value={type}
                  onValueChange={(v) => {
                    setType(v as 'percentage' | 'fixed');
                    reset();
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Porcentaje (%)</SelectItem>
                    <SelectItem value="fixed">Euros al mes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ri-value">{type === 'percentage' ? 'Porcentaje' : 'Euros'}</Label>
                <Input
                  id="ri-value"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    reset();
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>Desde el</Label>
                <Select
                  value={effectiveDate}
                  onValueChange={(v) => {
                    setEffectiveDate(v);
                    reset();
                  }}
                >
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
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>Local</Label>
                <Select
                  value={facilityId}
                  onValueChange={(v) => {
                    setFacilityId(v);
                    reset();
                  }}
                >
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
                <Select
                  value={unitTypeId}
                  onValueChange={(v) => {
                    setUnitTypeId(v);
                    reset();
                  }}
                >
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
                  onChange={(e) => {
                    setMinMonths(e.target.value);
                    reset();
                  }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void calc()}
                disabled={preview.isPending || !effectiveDate}
              >
                <Calculator className="mr-1 h-4 w-4" />
                {preview.isPending ? 'Calculando…' : 'Ver a quién afecta'}
              </Button>
              {result && (
                <span className="text-sm">
                  <span className="font-medium">{result.affectedCount}</span> contratos ·{' '}
                  <span className="text-emerald-700 dark:text-emerald-400">
                    +{formatEur(result.mrrDelta)} al mes
                  </span>
                </span>
              )}
            </div>

            {result && <PreviewDetails result={result} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cerrar
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={create.isPending || !result || result.affectedCount === 0 || !name.trim()}
            >
              <TrendingUp className="mr-1 h-4 w-4" />
              {create.isPending ? 'Programando…' : 'Programar y avisar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PreviewDetails({ result }: { result: RentIncreasePreviewDto }) {
  return (
    <div className="space-y-2 text-sm">
      {result.raisedThisYear > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {result.raisedThisYear} ya tuvieron una subida en los últimos 12 meses. El contrato dice
          que la cuota se revisa una vez al año.
        </p>
      )}
      {result.noEmail > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          {result.noEmail} no tienen email: no les llegará el preaviso, avísales tú.
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
      {result.affectedCount === 0 && (
        <p className="text-muted-foreground">
          Ningún contrato cumple estos criterios. Prueba con menos antigüedad, otro local o tamaño;
          los que ya tienen una subida programada no entran en otra.
        </p>
      )}
      {result.contracts.length > 0 && (
        <ul className="max-h-60 divide-y overflow-auto rounded-md border">
          {result.contracts.map((c) => (
            <li key={c.contractId} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
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
                {c.effectiveDate && c.effectiveDate !== result.contracts[0]?.effectiveDate && (
                  <span className="text-muted-foreground">
                    {' '}
                    · desde {formatDate(c.effectiveDate)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Importes sin IVA. Quien paga por adelantado cambia al empezar su siguiente periodo.
      </p>
    </div>
  );
}

function DetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useRentIncrease(id ?? undefined);
  const ri = detail.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ri?.name ?? 'Subida'}</DialogTitle>
          {ri && (
            <DialogDescription>
              {increaseLabel(ri)} · {ri.affectedCount} contratos · desde el{' '}
              {formatDate(ri.effectiveDate)} · {STATUS[ri.status].label}
              {ri.cancelledAt ? ` (cancelada el ${formatDate(ri.cancelledAt)})` : ''}
            </DialogDescription>
          )}
        </DialogHeader>
        {detail.isError && <SectionError onRetry={() => void detail.refetch()} />}
        {ri && (
          <ul className="divide-y rounded-md border text-sm">
            {(ri.items ?? []).map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
                <span className="min-w-0 flex-1">
                  <Link
                    href={`/contracts/${it.contractId}`}
                    className="font-medium hover:underline"
                  >
                    {it.customerName || it.contractNumber}
                  </Link>
                  <span className="text-muted-foreground">
                    {' '}
                    · {it.unitCode} · desde {formatDate(it.effectiveDate)}
                  </span>
                </span>
                <span className="text-xs">
                  {formatEur(it.oldPrice)} → <strong>{formatEur(it.newPrice)}</strong>
                </span>
                <span className="w-full text-xs text-muted-foreground sm:w-auto">
                  {it.status === 'applied'
                    ? 'Aplicada'
                    : it.status === 'skipped'
                      ? `No se subió: ${RENT_INCREASE_SKIP_LABELS[it.skipReason ?? ''] ?? it.skipReason ?? ''}`
                      : 'Pendiente'}
                  {it.noticeStatus ? ` · ${NOTICE[it.noticeStatus]}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Política: preaviso, tope en 12 meses y meses mínimos entre subidas al mismo contrato. */
function PolicyCard() {
  const { data } = useRentIncreasePolicy();
  const update = useUpdateRentIncreasePolicy();
  const [maxPct, setMaxPct] = useState('0');
  const [minMonths, setMinMonths] = useState('12');
  const [noticeDays, setNoticeDays] = useState('30');

  useEffect(() => {
    if (!data) return;
    setMaxPct(String(data.maxAnnualPct));
    setMinMonths(String(data.minMonthsBetween));
    setNoticeDays(String(data.noticeDays));
  }, [data]);

  async function save() {
    try {
      await update.mutateAsync({
        maxAnnualPct: Math.max(0, Number(maxPct.replace(',', '.')) || 0),
        minMonthsBetween: Math.max(0, Math.floor(Number(minMonths) || 0)),
        noticeDays: Math.max(1, Math.floor(Number(noticeDays) || 30)),
      });
      toast.success('Política de subidas guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Política de subidas</CardTitle>
        <p className="text-xs text-muted-foreground">
          El contrato estándar dice que la cuota se revisa una vez al año y se avisa con 30 días. Se
          aplica al calcular a quién afecta cada subida.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-[repeat(3,minmax(0,13rem))_auto] sm:items-start">
        <div className="space-y-1">
          <Label htmlFor="pol-notice">Preaviso (días)</Label>
          <Input
            id="pol-notice"
            inputMode="numeric"
            value={noticeDays}
            onChange={(e) => setNoticeDays(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pol-cap">Tope en 12 meses (%)</Label>
          <Input
            id="pol-cap"
            inputMode="decimal"
            value={maxPct}
            onChange={(e) => setMaxPct(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">0 = sin tope</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pol-min">Meses entre subidas</Label>
          <Input
            id="pol-min"
            inputMode="numeric"
            value={minMonths}
            onChange={(e) => setMinMonths(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Al mismo contrato</p>
        </div>
        <Button
          variant="outline"
          className="w-fit sm:mt-6"
          onClick={() => void save()}
          disabled={update.isPending}
        >
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
