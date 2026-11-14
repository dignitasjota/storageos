'use client';

import {
  RENT_INCREASE_SKIP_LABELS,
  type RentIncreaseDto,
  type RentIncreaseItemDto,
  type RentIncreaseResultsDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, Send, UserMinus, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CreateWizard } from './create-wizard';
import { NoticeTemplateCard } from './notice-template-card';

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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur } from '@/lib/format';
import {
  useApplyRentIncrease,
  useCancelRentIncrease,
  useRentIncrease,
  useRentIncreaseItemAction,
  useRentIncreasePolicy,
  useRentIncreaseResults,
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

const increaseLabel = (r: Pick<RentIncreaseDto, 'increaseType' | 'increaseValue'>) =>
  r.increaseType === 'percentage'
    ? `+${r.increaseValue} %`
    : r.increaseType === 'to_list_price'
      ? `Hasta tarifa (máx. +${r.increaseValue} %)`
      : `+${formatEur(r.increaseValue)}`;

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

      {canManage && companyWide && (
        <div className="grid gap-4 lg:grid-cols-2">
          <PolicyCard />
          <NoticeTemplateCard />
        </div>
      )}

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
          toolbarRight={canManage ? <CreateWizard /> : null}
        />
      )}

      <DetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function DetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const ask = useConfirm();
  const detail = useRentIncrease(id ?? undefined);
  const ri = detail.data;
  const canManage = useHasPermission('contracts:manage');
  const results = useRentIncreaseResults(id ?? undefined, !!ri && ri.status !== 'cancelled');
  const itemAction = useRentIncreaseItemAction();
  const scheduled = ri?.status === 'scheduled';

  async function removeItem(it: RentIncreaseItemDto) {
    if (!ri) return;
    if (
      !(await ask({
        title: `¿Quitar a ${it.customerName || it.contractNumber} de la subida?`,
        description:
          it.noticeStatus === 'sent'
            ? 'Su cuota no cambiará y le llega un correo diciendo que la subida queda anulada.'
            : 'Su cuota no cambiará.',
        confirmLabel: 'Quitar',
        destructive: true,
      }))
    )
      return;
    try {
      await itemAction.mutateAsync({ id: ri.id, itemId: it.id, action: 'remove' });
      toast.success('Quitado de la subida.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  async function resend(it: RentIncreaseItemDto) {
    if (!ri) return;
    try {
      await itemAction.mutateAsync({ id: ri.id, itemId: it.id, action: 'resend' });
      toast.success('Aviso enviado otra vez.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ri?.name ?? 'Subida'}</DialogTitle>
          {ri && (
            <DialogDescription>
              {increaseLabel(ri)} · {ri.affectedCount}{' '}
              {ri.affectedCount === 1 ? 'contrato' : 'contratos'} · desde el{' '}
              {formatDate(ri.effectiveDate)} · {STATUS[ri.status].label}
              {ri.cancelledAt ? ` (cancelada el ${formatDate(ri.cancelledAt)})` : ''}
            </DialogDescription>
          )}
        </DialogHeader>
        {detail.isError && <SectionError onRetry={() => void detail.refetch()} />}
        {results.data && (results.data.applied > 0 || results.data.left.length > 0) && (
          <ResultsSummary results={results.data} />
        )}
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
                <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {it.status === 'applied'
                      ? 'Aplicada'
                      : it.status === 'skipped'
                        ? `No se subió: ${RENT_INCREASE_SKIP_LABELS[it.skipReason ?? ''] ?? it.skipReason ?? ''}`
                        : 'Pendiente'}
                  </span>
                  <NoticeBadge item={it} />
                  {canManage && scheduled && it.status === 'pending' && (
                    <span className="ml-auto flex gap-1">
                      {(it.noticeStatus !== 'sent' ||
                        it.noticeDelivery === 'bounced' ||
                        it.noticeDelivery === 'failed') && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => void resend(it)}
                          disabled={itemAction.isPending}
                        >
                          <Send className="mr-1 h-3.5 w-3.5" /> Reenviar aviso
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7"
                        onClick={() => void removeItem(it)}
                        disabled={itemAction.isPending}
                      >
                        <UserMinus className="mr-1 h-3.5 w-3.5" /> Quitar
                      </Button>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Qué ha pasado con el correo del aviso de un contrato. */
function NoticeBadge({ item }: { item: RentIncreaseItemDto }) {
  if (item.noticeStatus === 'no_email') {
    return <Badge variant="outline">Sin email: avísale tú</Badge>;
  }
  if (item.noticeStatus === 'failed' || item.noticeDelivery === 'failed') {
    return <Badge variant="destructive">Aviso no enviado</Badge>;
  }
  if (item.noticeDelivery === 'bounced') {
    return <Badge variant="destructive">Aviso rebotado</Badge>;
  }
  if (item.noticeDelivery === 'delivered') return <Badge variant="default">Aviso entregado</Badge>;
  if (item.noticeDelivery === 'sent') return <Badge variant="secondary">Aviso enviado</Badge>;
  if (item.noticeDelivery === 'pending') return <Badge variant="outline">Enviando aviso…</Badge>;
  return null;
}

/** Lo que ha dado la subida: lo previsto, lo que se cobra de verdad y quién se fue. */
function ResultsSummary({ results: r }: { results: RentIncreaseResultsDto }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Previsto al mes" value={`+${formatEur(r.plannedMonthly)}`} />
        <Stat label="Se cobra de más" value={`+${formatEur(r.realMonthly)}`} />
        <Stat label="Ya facturado de más" value={formatEur(r.extraInvoiced)} />
        <Stat
          label="Bajas tras el aviso"
          value={String(r.left.length)}
          tone={r.left.length > 0 ? 'warn' : undefined}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {r.applied} subidos · {r.pending} pendientes · {r.skipped} no subidos. Importes sin IVA.
      </p>
      {r.left.length > 0 && (
        <div className="text-xs">
          <p className="font-medium">
            Se fueron o pidieron la baja después del aviso (pagaban {formatEur(r.lostMonthly)} al
            mes):
          </p>
          <ul className="mt-1 space-y-0.5">
            {r.left.map((l) => (
              <li key={l.contractId}>
                <Link href={`/contracts/${l.contractId}`} className="hover:underline">
                  {l.customerName}
                </Link>{' '}
                · {l.unitCode}
                {l.endDate ? ` · fin ${formatDate(l.endDate)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-semibold ${tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : ''}`}>
        {value}
      </p>
    </div>
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
      <CardContent className="grid gap-3 sm:grid-cols-3 sm:items-start">
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
          className="w-fit sm:col-span-3"
          onClick={() => void save()}
          disabled={update.isPending}
        >
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
