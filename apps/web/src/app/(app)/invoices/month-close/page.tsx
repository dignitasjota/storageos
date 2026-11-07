'use client';

import {
  MONTH_CLOSE_WARNING_LABELS,
  type BulkInvoiceActionResultDto,
  type MonthCloseRowDto,
} from '@storageos/shared';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { MonthYearSelect, ym } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { bulkFailureLines, toastBulkResult } from '@/lib/billing/bulk-report';
import {
  useBulkChargeInvoices,
  useBulkIssueInvoices,
  useBulkRemindInvoices,
  useGenerateMonth,
  useMonthClose,
} from '@/lib/billing/hooks';
import { formatEur } from '@/lib/format';

type Step = 'issue' | 'charge' | 'remind';

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
}

function currentMonth(): string {
  const now = new Date();
  return ym(now.getFullYear(), now.getMonth() + 1);
}

/** Lo que pasó en el último paso en lote, para que no se pierda con el aviso. */
function ResultNote({ res, done }: { res: BulkInvoiceActionResultDto; done: string }) {
  const processing = res.processing?.length ?? 0;
  const ok = res.succeeded.length - processing;
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
      <p>
        {ok} {done}
        {processing > 0 && ` · ${processing} por domiciliación (el banco las confirma en 2-5 días)`}
        {res.failed.length > 0 && ` · ${res.failed.length} sin hacer`}
      </p>
      {res.failed.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {bulkFailureLines(res, 20).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RowLine({
  row,
  selectable,
  checked,
  onToggle,
}: {
  row: MonthCloseRowDto;
  selectable?: boolean;
  checked?: boolean;
  onToggle?: () => void;
}) {
  return (
    <li className="flex items-start gap-3 py-3 text-sm">
      {selectable && (
        <Checkbox
          className="mt-0.5"
          checked={checked}
          onCheckedChange={() => onToggle?.()}
          aria-label={`Seleccionar la factura de ${row.customerName ?? 'cliente sin identificar'}`}
        />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={`/invoices/${row.invoiceId}`} className="font-medium hover:underline">
            {row.customerName ?? 'Cliente sin identificar'}
          </Link>
          <span className="tabular-nums">
            {formatEur(row.status === 'draft' ? row.total : row.amountPending)}
          </span>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {row.invoiceNumber && <span className="font-mono">{row.invoiceNumber}</span>}
          {row.unitCode && (
            <span>
              Trastero {row.unitCode}
              {row.facilityName && ` (${row.facilityName})`}
            </span>
          )}
          {row.status !== 'draft' && <InvoiceStatusBadge status={row.status} total={row.total} />}
          {row.status !== 'draft' && row.chargeable && <span>Con tarjeta o domiciliación</span>}
        </p>
        {row.warnings.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {row.warnings.map((w) => (
              <Badge
                key={w}
                variant="outline"
                className="border-amber-400 font-normal text-amber-800 dark:text-amber-300"
              >
                {MONTH_CLOSE_WARNING_LABELS[w]}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Cierre del mes: generar las facturas que faltan, revisar los borradores con
 * sus avisos, emitirlos y cobrar o recordar lo pendiente, con el resultado de
 * cada factura.
 */
export default function MonthClosePage() {
  const ask = useConfirm();
  const [month, setMonth] = useState(currentMonth);
  const close = useMonthClose(month);
  const generate = useGenerateMonth();
  const bulkIssue = useBulkIssueInvoices();
  const bulkCharge = useBulkChargeInvoices();
  const bulkRemind = useBulkRemindInvoices();
  const canManage = useHasPermission('invoices:manage');
  const canCharge = useHasPermission('payments:charge');
  const canRemind = useHasPermission('communications:send');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ step: Step; res: BulkInvoiceActionResultDto } | null>(
    null,
  );

  const data = close.data;
  const draftIds = (data?.drafts ?? []).map((d) => d.invoiceId).join(',');
  // Al cargar o cambiar los borradores, se marcan todos (se quitan los que no).
  useEffect(() => {
    setSelected(new Set(draftIds ? draftIds.split(',') : []));
  }, [draftIds]);
  useEffect(() => {
    setResult(null);
  }, [month]);

  const chargeable = (data?.pending ?? []).filter((r) => r.chargeable);
  const manual = (data?.pending ?? []).filter((r) => !r.chargeable);
  const label = monthLabel(month);
  const issuerMissing = data?.issuerMissing ?? [];

  async function onGenerate(): Promise<void> {
    try {
      const { created } = await generate.mutateAsync(month);
      toast.success(
        created === 0
          ? 'No faltaba ninguna factura.'
          : `${created} ${created === 1 ? 'borrador creado' : 'borradores creados'}: revísalos y emítelos.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido generar.');
    }
  }

  async function onIssue(): Promise<void> {
    const ids = [...selected];
    if (
      !(await ask({
        title: `¿Emitir ${ids.length} ${ids.length === 1 ? 'factura' : 'facturas'}?`,
        description:
          'Cada una recibe su número y se registra en Veri*Factu. Después ya no se puede borrar, solo rectificar.',
        confirmLabel: 'Emitir',
      }))
    )
      return;
    try {
      const res = await bulkIssue.mutateAsync(ids);
      setResult({ step: 'issue', res });
      toastBulkResult(res, 'emitidas');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido emitir.');
    }
  }

  async function onCharge(): Promise<void> {
    const total = chargeable.reduce((sum, r) => sum + r.amountPending, 0);
    if (
      !(await ask({
        title: `¿Cobrar ${chargeable.length} ${chargeable.length === 1 ? 'factura' : 'facturas'} (${formatEur(total)})?`,
        description: 'Se cobra a cada inquilino con su tarjeta o su domiciliación guardada.',
        confirmLabel: 'Cobrar',
      }))
    )
      return;
    try {
      const res = await bulkCharge.mutateAsync(chargeable.map((r) => r.invoiceId));
      setResult({ step: 'charge', res });
      toastBulkResult(res, 'cobradas', 'por domiciliación (el banco las confirma en 2-5 días)');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido cobrar.');
    }
  }

  async function onRemind(): Promise<void> {
    if (
      !(await ask({
        title: `¿Enviar un recordatorio de pago a ${manual.length} ${manual.length === 1 ? 'inquilino' : 'inquilinos'}?`,
        description:
          'Les llega un correo con lo que deben y el enlace para pagar; si alguien debe varias, van todas en el mismo correo. A quien ya recibió uno hoy no se le envía otro.',
        confirmLabel: 'Enviar',
      }))
    )
      return;
    try {
      const res = await bulkRemind.mutateAsync(manual.map((r) => r.invoiceId));
      setResult({ step: 'remind', res });
      toastBulkResult(res, 'recordatorios enviados');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido enviar.');
    }
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/invoices">
            <ArrowLeft className="mr-1 h-4 w-4" /> Facturas
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Cierre del mes</h1>
            <p className="text-sm text-muted-foreground">
              Las facturas de alquiler de {label}: genera las que faltan, revísalas, emítelas y
              cobra lo pendiente.
            </p>
          </div>
          <MonthYearSelect value={month} onChange={setMonth} />
        </div>
      </div>

      {close.isError ? (
        <SectionError onRetry={() => void close.refetch()} />
      ) : !data ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {issuerMissing.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="size-4 shrink-0" />
              <span className="flex-1">
                Para emitir faltan datos fiscales de tu empresa: {issuerMissing.join(', ')}.
              </span>
              <Button size="sm" variant="outline" asChild>
                <Link href="/settings/company">Completarlos</Link>
              </Button>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">1. Generar las que faltan</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
              {data.missingContracts === 0 ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="size-4 text-emerald-600" /> Todos los contratos tienen su
                  factura de {label}.
                </p>
              ) : (
                <>
                  <p>
                    {data.missingContracts}{' '}
                    {data.missingContracts === 1
                      ? 'contrato aún no tiene'
                      : 'contratos aún no tienen'}{' '}
                    la factura de {label}.{' '}
                    {month === currentMonth()
                      ? 'Las del mes en curso se crean solas cada noche; puedes generarlas ya.'
                      : 'Las de un mes ya pasado no se crean solas: genéralas aquí.'}
                  </p>
                  {canManage && (
                    <Button disabled={generate.isPending} onClick={() => void onGenerate()}>
                      {generate.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      Generar {data.missingContracts}
                    </Button>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. Revisar y emitir</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.drafts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hay borradores de {label}.</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Mira los avisos antes de emitir. Lo que no quieras emitir aún, desmárcalo.
                  </p>
                  <ul className="divide-y">
                    {data.drafts.map((row) => (
                      <RowLine
                        key={row.invoiceId}
                        row={row}
                        selectable={canManage}
                        checked={selected.has(row.invoiceId)}
                        onToggle={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.invoiceId)) next.delete(row.invoiceId);
                            else next.add(row.invoiceId);
                            return next;
                          })
                        }
                      />
                    ))}
                  </ul>
                  {canManage && (
                    <Button
                      disabled={selected.size === 0 || bulkIssue.isPending}
                      onClick={() => void onIssue()}
                    >
                      {bulkIssue.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      Emitir {selected.size}
                    </Button>
                  )}
                </>
              )}
              {result?.step === 'issue' && <ResultNote res={result.res} done="emitidas" />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">3. Cobrar lo pendiente</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.pending.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  {data.paidCount > 0
                    ? `Nada pendiente: ${data.paidCount} ${data.paidCount === 1 ? 'factura cobrada' : 'facturas cobradas'} de ${label}.`
                    : `No hay facturas emitidas de ${label} pendientes de cobro.`}
                </p>
              ) : (
                <>
                  <ul className="divide-y">
                    {data.pending.map((row) => (
                      <RowLine key={row.invoiceId} row={row} />
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    {canCharge && chargeable.length > 0 && (
                      <Button disabled={bulkCharge.isPending} onClick={() => void onCharge()}>
                        {bulkCharge.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                        {chargeable.length === 1
                          ? 'Cobrar la que tiene forma de pago'
                          : `Cobrar las ${chargeable.length} con forma de pago`}
                      </Button>
                    )}
                    {canRemind && manual.length > 0 && (
                      <Button
                        variant="outline"
                        disabled={bulkRemind.isPending}
                        onClick={() => void onRemind()}
                      >
                        {bulkRemind.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                        {manual.length === 1
                          ? 'Enviar un recordatorio a la que no tiene forma de pago'
                          : `Enviar un recordatorio a las ${manual.length} sin forma de pago`}
                      </Button>
                    )}
                  </div>
                  {data.paidCount > 0 && (
                    <p className="text-xs text-muted-foreground">Ya cobradas: {data.paidCount}.</p>
                  )}
                </>
              )}
              {result?.step === 'charge' && <ResultNote res={result.res} done="cobradas" />}
              {result?.step === 'remind' && (
                <ResultNote res={result.res} done="recordatorios enviados" />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
