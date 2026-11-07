'use client';

import {
  INVOICE_TAX_CATEGORY_LABELS,
  type CorrectionMethodValue,
  type InvoiceDto,
  type InvoiceTaxCategory,
  type RectificationTypeValue,
} from '@storageos/shared';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Plus,
  Receipt,
  Send,
  Trash2,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { DateSelect } from '@/components/month-year-select';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { VerifactuBadge } from '@/components/verifactu-badge';
import { useHoldedSettings, useSyncInvoiceHolded } from '@/lib/accounting/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  fetchLateFeePreview,
  useCancelInvoice,
  useChargeInvoice,
  useCustomerPaymentMethods,
  useGenerateInvoicePdf,
  useInvoice,
  useInvoiceSignedPdfUrl,
  useIssueInvoice,
  useLateFeeInvoice,
  useMarkInvoicePaid,
  useRectifyInvoice,
  useRefundInvoice,
  useUpdateInvoice,
} from '@/lib/billing/hooks';
import { invoiceNumberLabel, isNumbered } from '@/lib/billing/labels';
import { formatDate, formatEur } from '@/lib/format';
import { fetchRedsysRedirect, submitRedsysForm, useRedsysSettings } from '@/lib/payments/redsys';

/**
 * Tipos de factura rectificativa (RD 1619/2012 art. 15), con palabras de la
 * calle para el desplegable y el detalle.
 */
const RECTIFICATION_TYPE_LABELS: Record<RectificationTypeValue, string> = {
  R1: 'R1 · Error en la factura (importe, datos, IVA…)',
  R2: 'R2 · El cliente está en concurso de acreedores',
  R3: 'R3 · Deuda incobrable',
  R4: 'R4 · Otras causas (descuento, devolución…)',
  R5: 'R5 · Rectifica una factura simplificada',
};

const RECTIFIABLE_STATUSES = new Set<InvoiceDto['status']>([
  'issued',
  'paid',
  'overdue',
  'refunded',
  'partially_refunded',
]);

const METHOD_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  sepa_debit: 'Domiciliación SEPA',
  card: 'Tarjeta (TPV del local)',
  other: 'Otro (Bizum, cheque…)',
};

interface RectifyDraftItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  /** Tipo fiscal de la línea original (al 0 %: exenta o no sujeta). */
  taxCategory?: InvoiceTaxCategory;
}

/** Líneas de partida: por diferencias, todo en negativo (resta lo facturado). */
function rectifyStart(i: InvoiceDto, method: CorrectionMethodValue): RectifyDraftItem[] {
  return i.items.map((it) => ({
    description: it.description,
    quantity: it.quantity,
    unitPrice: method === 'by_differences' ? -it.unitPrice : it.unitPrice,
    taxRate: it.taxRate,
    taxCategory: it.taxCategory,
  }));
}

function lineTotal(it: { quantity: number; unitPrice: number; taxRate: number }): number {
  const base = Math.round(it.quantity * it.unitPrice * 100);
  return (base + Math.round((base * it.taxRate) / 100)) / 100;
}

export default function InvoiceDetailPage() {
  const ask = useConfirm();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const invoice = useInvoice(id);

  const issue = useIssueInvoice();
  const cancel = useCancelInvoice();
  const refund = useRefundInvoice();
  const markPaid = useMarkInvoicePaid();
  const charge = useChargeInvoice();
  const generatePdf = useGenerateInvoicePdf();
  const signedPdfUrl = useInvoiceSignedPdfUrl();
  const holdedSync = useSyncInvoiceHolded();
  const rectify = useRectifyInvoice();
  const lateFee = useLateFeeInvoice();
  const updateInvoice = useUpdateInvoice();
  const canRefund = useHasPermission('invoices:refund');
  const canManageInv = useHasPermission('invoices:manage');
  const canWriteInv = useHasPermission('invoices:write');
  const canCharge = useHasPermission('payments:charge');
  // «Pagar con tarjeta» solo si el negocio lo tiene activo (sin permiso para
  // leer los ajustes no se sabe: se muestra y el API responde).
  const canReadSettings = useHasPermission('settings:read');
  const redsys = useRedsysSettings(canReadSettings);
  const redsysAvailable = !canReadSettings || !!redsys.data?.enabled;
  const holded = useHoldedSettings(canReadSettings && canManageInv);
  const methods = useCustomerPaymentMethods(
    canCharge ? (invoice.data?.customerId ?? undefined) : undefined,
  );
  const chargeable = (methods.data ?? []).some((m) => m.type === 'card' || m.type === 'sepa_debit');

  const [paidOpen, setPaidOpen] = useState(false);
  const [paidAmount, setPaidAmount] = useState(0);
  const [paidMethod, setPaidMethod] = useState<
    'cash' | 'bank_transfer' | 'card' | 'sepa_debit' | 'other'
  >('cash');
  const [paidOverride, setPaidOverride] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState(0);
  const [refundReason, setRefundReason] = useState('');
  const [rectifyOpen, setRectifyOpen] = useState(false);
  const [rectifyType, setRectifyType] = useState<RectificationTypeValue>('R1');
  const [rectifyMethod, setRectifyMethod] = useState<CorrectionMethodValue>('by_differences');
  const [rectifyReason, setRectifyReason] = useState('');
  const [rectifyItems, setRectifyItems] = useState<RectifyDraftItem[]>([]);
  const [dueOpen, setDueOpen] = useState(false);
  const [dueDate, setDueDate] = useState<string | undefined>();
  const [dueReason, setDueReason] = useState('');

  if (invoice.isError) {
    const missing = invoice.error instanceof ApiError && invoice.error.statusCode === 404;
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/invoices">
            <ArrowLeft className="mr-1 h-4 w-4" /> Facturas
          </Link>
        </Button>
        {missing ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Esta factura no existe o ya no está disponible.
          </p>
        ) : (
          <SectionError onRetry={() => void invoice.refetch()} />
        )}
      </div>
    );
  }

  if (invoice.isLoading || !invoice.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const i = invoice.data;
  const isDraft = i.status === 'draft';
  // Una rectificativa que se quedó en borrador cancelado no rectifica nada.
  const rectifiedBy = i.rectifiedBy.filter((r) => r.status !== 'cancelled');
  const isRectification = i.invoiceType.startsWith('R');
  const pendingStatus = i.status === 'issued' || i.status === 'overdue';
  // Dinero que de verdad entró: sin la retención de IRPF ni lo saldado con un abono.
  const collected = Math.max(
    0,
    Math.round((i.amountPaid - i.withholdingAmount - i.amountCompensated) * 100) / 100,
  );
  const refundable = Math.max(0, Math.round((collected - i.amountRefunded) * 100) / 100);

  async function safe<T>(fn: () => Promise<T>, ok: string): Promise<void> {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      // Sin los datos fiscales del emisor no se puede emitir ni anular: se lleva a completarlos.
      if (err instanceof ApiError && err.body.code === 'issuer_fiscal_data_required') {
        const ownerId = (err.body.details as { ownerId?: string } | undefined)?.ownerId;
        toast.error(err.body.message, {
          duration: 12_000,
          action: {
            label: 'Completar',
            onClick: () => router.push(ownerId ? '/owners' : '/settings/company'),
          },
        });
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido hacer.');
    }
  }

  async function handleCharge(): Promise<void> {
    if (
      !(await ask({
        title: `¿Cobrar ${formatEur(i.amountPending)} con la forma de pago del inquilino?`,
        description: 'Se cobra con su tarjeta o su domiciliación guardada.',
      }))
    )
      return;
    try {
      const payment = await charge.mutateAsync({ invoiceId: i.id, input: {} });
      if (payment.status === 'processing') {
        // SEPA: el banco liquida en 2-5 días hábiles; la factura se marca
        // pagada sola al confirmarse.
        toast.info('Cobro por domiciliación iniciado: el banco lo confirma en 2-5 días hábiles.');
      } else if (payment.status === 'succeeded') {
        toast.success('Cobro realizado.');
      } else {
        toast.error(
          payment.failureReason
            ? `El cobro no se completó: ${payment.failureReason}`
            : 'El cobro no se completó.',
        );
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido cobrar.');
    }
  }

  async function onDownloadPdf(): Promise<void> {
    try {
      const { url } = await signedPdfUrl.mutateAsync(i.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo descargar el PDF');
    }
  }

  async function handleLateFee(): Promise<void> {
    let amount: number;
    try {
      amount = (await fetchLateFeePreview(i.id)).amount;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se puede aplicar el recargo.');
      return;
    }
    if (
      !(await ask({
        title: `¿Emitir un recargo por mora de ${formatEur(amount)}?`,
        description: 'Se emite como una factura aparte, sin IVA, vinculada a esta.',
      }))
    )
      return;
    try {
      const fee = await lateFee.mutateAsync({ id: i.id });
      toast.success(`Recargo emitido: ${fee.invoiceNumber} (${formatEur(fee.total)}).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido emitir.');
    }
  }

  async function submitRefund(registeredExternally = false): Promise<void> {
    try {
      await refund.mutateAsync({
        id: i.id,
        body: {
          amount: refundAmount,
          reason: refundReason,
          ...(registeredExternally ? { registeredExternally: true } : {}),
        },
      });
      setRefundOpen(false);
      toast.success(registeredExternally ? 'Devolución registrada.' : 'Devolución hecha.');
    } catch (err) {
      // Cobro con el TPV del banco: la app no puede devolverlo; se registra la
      // devolución hecha allí.
      if (err instanceof ApiError && err.body.code === 'refund_needs_bank') {
        if (
          await ask({
            title: '¿Ya lo has devuelto en el banco?',
            description:
              'Este cobro se hizo con el TPV del banco y la app no puede devolverlo. Devuélvelo en el banco o en el panel del TPV y confirma aquí para registrarlo.',
            confirmLabel: 'Ya está devuelto',
          })
        ) {
          await submitRefund(true);
        }
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido devolver.');
    }
  }

  async function handleCancel(): Promise<void> {
    const confirmed = await ask(
      isDraft
        ? {
            title: '¿Cancelar este borrador?',
            description: i.periodStart
              ? 'No se volverá a generar solo. Si lo necesitas, crea otra factura.'
              : 'No tiene número ni efecto fiscal.',
            destructive: true,
          }
        : {
            title: '¿Anular la factura?',
            description:
              'Se emite una rectificativa que la deja a cero (queda registrada en Veri*Factu y en la contabilidad). Si tenía un recargo por mora sin cobrar, también se anula.',
            destructive: true,
          },
    );
    if (!confirmed) return;
    await safe(
      () => cancel.mutateAsync({ id: i.id, body: { reason: 'Anulación manual' } }),
      isDraft ? 'Borrador cancelado.' : 'Factura anulada.',
    );
  }

  const rectifyTotal = rectifyItems.reduce((sum, it) => sum + lineTotal(it), 0);
  const rectifyValid =
    rectifyReason.trim().length > 0 &&
    rectifyItems.length > 0 &&
    rectifyItems.every((it) => it.description.trim() && it.quantity > 0 && it.unitPrice !== 0);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/invoices">
            <ArrowLeft className="mr-1 h-4 w-4" /> Facturas
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">
                {invoiceNumberLabel(i)}
              </h1>
              <InvoiceStatusBadge status={i.status} total={i.total} />
              {i.issuedBy === 'holded' && isDraft ? (
                <Badge
                  variant="outline"
                  className="border-amber-400 text-amber-700 dark:text-amber-300"
                  title="Créala en Holded desde la factura original y enlázala en Ajustes → Facturación → Holded"
                >
                  Pendiente de hacer en Holded
                </Badge>
              ) : i.issuedBy === 'holded' ? (
                <Badge variant="outline" title="Holded la numeró y la registra en Veri*Factu">
                  Emitida en Holded
                </Badge>
              ) : (
                i.kind === 'invoice' && <VerifactuBadge invoice={i} />
              )}
              {i.kind === 'deposit_receipt' && (
                <Badge variant="outline" title="Garantía reembolsable: sin IVA ni Veri*Factu">
                  Justificante de fianza
                </Badge>
              )}
              {i.invoiceType === 'F2' && <Badge variant="outline">Simplificada</Badge>}
              {i.lateFeeForInvoiceId && <Badge variant="outline">Recargo por mora</Badge>}
              {isRectification && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="secondary" className="gap-1">
                        <Receipt className="size-3" />
                        Rectificativa {i.invoiceType}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-1 text-xs">
                        <p>
                          {RECTIFICATION_TYPE_LABELS[i.invoiceType as RectificationTypeValue] ??
                            i.invoiceType}
                        </p>
                        {i.rectificationReason && <p>Motivo: {i.rectificationReason}</p>}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            {isRectification && i.rectifiesInvoiceId && (
              <p className="text-sm text-muted-foreground">
                Rectifica la factura{' '}
                <Link href={`/invoices/${i.rectifiesInvoiceId}`} className="underline">
                  {i.rectifiesInvoiceNumber}
                </Link>
                {i.rectificationReason && <> · {i.rectificationReason}</>}
              </p>
            )}
            {rectifiedBy.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {i.status === 'rectified' ? 'Anulada con la rectificativa ' : 'Rectificada por '}
                {rectifiedBy.map((r, idx) => (
                  <span key={r.id}>
                    {idx > 0 && ', '}
                    <Link href={`/invoices/${r.id}`} className="underline">
                      {r.invoiceNumber ?? 'una rectificativa en borrador'}
                    </Link>
                  </span>
                ))}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {i.customerId ? (
                <Link href={`/customers/${i.customerId}`} className="hover:underline">
                  {i.customerName ?? 'Cliente'}
                </Link>
              ) : (
                <span className="italic">Cliente no identificado</span>
              )}
              {i.contractNumber && i.contractId && (
                <>
                  {' · contrato '}
                  <Link href={`/contracts/${i.contractId}`} className="hover:underline">
                    {i.contractNumber}
                  </Link>
                </>
              )}
              {i.unitCode && (
                <>
                  {' · trastero '}
                  {i.unitId ? (
                    <Link href={`/units/${i.unitId}`} className="hover:underline">
                      {i.unitCode}
                    </Link>
                  ) : (
                    i.unitCode
                  )}
                  {i.facilityName && ` (${i.facilityName})`}
                </>
              )}
              {i.ownerName && <> · emitida por {i.ownerName}</>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isDraft && canManageInv && i.issuedBy !== 'holded' && (
              <Button
                disabled={issue.isPending}
                onClick={() => safe(() => issue.mutateAsync({ id: i.id }), 'Factura emitida.')}
              >
                {issue.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-1 h-4 w-4" />
                )}
                Emitir
              </Button>
            )}
            {pendingStatus && i.amountPending > 0 && (
              <>
                {canCharge && i.customerId && chargeable && (
                  <Button
                    variant="outline"
                    onClick={() => void handleCharge()}
                    disabled={charge.isPending}
                  >
                    Cobrar con su forma de pago
                  </Button>
                )}
                {canWriteInv && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPaidAmount(i.amountPending);
                      // Si el inquilino dijo cómo iba a pagar, se propone esa forma.
                      setPaidMethod(i.offlinePaymentMethod ?? 'cash');
                      setPaidOverride(false);
                      setPaidOpen(true);
                    }}
                  >
                    <CheckCircle2 className="mr-1 h-4 w-4" /> Registrar cobro
                  </Button>
                )}
                {canManageInv &&
                  i.status === 'overdue' &&
                  !i.lateFeeInvoiceId &&
                  !i.lateFeeForInvoiceId && (
                    <Button
                      variant="outline"
                      onClick={() => void handleLateFee()}
                      disabled={lateFee.isPending}
                    >
                      Aplicar recargo
                    </Button>
                  )}
              </>
            )}
            {i.lateFeeInvoiceId && (
              <Button variant="outline" asChild>
                <Link href={`/invoices/${i.lateFeeInvoiceId}`}>Ver recargo</Link>
              </Button>
            )}
            {i.lateFeeForInvoiceId && (
              <Button variant="outline" asChild>
                <Link href={`/invoices/${i.lateFeeForInvoiceId}`}>Ver factura vencida</Link>
              </Button>
            )}
            {canRefund &&
              i.total > 0 &&
              (i.status === 'paid' || i.status === 'partially_refunded') &&
              refundable > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setRefundAmount(refundable);
                    setRefundReason('');
                    setRefundOpen(true);
                  }}
                >
                  <Undo2 className="mr-1 h-4 w-4" /> Devolver
                </Button>
              )}
            {canManageInv &&
              (isDraft || pendingStatus) &&
              (i.invoiceType === 'F1' || i.invoiceType === 'F2' || isDraft) && (
                <Button
                  variant="destructive"
                  disabled={cancel.isPending}
                  onClick={() => void handleCancel()}
                >
                  <Ban className="mr-1 h-4 w-4" /> {isDraft ? 'Cancelar' : 'Anular'}
                </Button>
              )}
            {canManageInv &&
              (i.invoiceType === 'F1' || i.invoiceType === 'F2') &&
              i.kind === 'invoice' &&
              RECTIFIABLE_STATUSES.has(i.status) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setRectifyType(i.invoiceType === 'F2' ? 'R5' : 'R1');
                    setRectifyMethod('by_differences');
                    setRectifyReason('');
                    setRectifyItems(rectifyStart(i, 'by_differences'));
                    setRectifyOpen(true);
                  }}
                >
                  <Receipt className="mr-1 h-4 w-4" /> Rectificar
                </Button>
              )}
            {!isDraft && i.status !== 'cancelled' && canManageInv && (
              <Button
                variant="outline"
                onClick={() => safe(() => generatePdf.mutateAsync(i.id), 'PDF generado.')}
                disabled={generatePdf.isPending}
              >
                {generatePdf.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <FileText className="mr-1 h-4 w-4" />
                )}
                {i.hasPdf ? 'Regenerar PDF' : 'Generar PDF'}
              </Button>
            )}
            {i.hasPdf && (
              <Button variant="outline" onClick={onDownloadPdf} disabled={signedPdfUrl.isPending}>
                {signedPdfUrl.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-1 h-4 w-4" />
                )}
                Descargar
              </Button>
            )}
            {canCharge && redsysAvailable && pendingStatus && i.amountPending > 0 && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    submitRedsysForm(await fetchRedsysRedirect(i.id));
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido.');
                  }
                }}
              >
                Pagar con tarjeta
              </Button>
            )}
            {canManageInv &&
              holded.data?.ready &&
              i.issuedBy !== 'holded' &&
              i.kind === 'invoice' &&
              (i.status === 'issued' || i.status === 'paid' || i.status === 'overdue') &&
              i.customerId &&
              (i.holdedDocumentId ? (
                <span className="self-center text-xs text-muted-foreground">
                  Exportada a Holded
                </span>
              ) : (
                <Button
                  variant="outline"
                  disabled={holdedSync.isPending}
                  onClick={async () => {
                    try {
                      await holdedSync.mutateAsync(i.id);
                      toast.success('Factura exportada a Holded.');
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido.');
                    }
                  }}
                >
                  Exportar a Holded
                </Button>
              ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{formatEur(i.total)}</p>
            <p className="text-xs text-muted-foreground">IVA {formatEur(i.taxAmount)}</p>
            {i.withholdingAmount > 0 && (
              <p className="text-xs text-muted-foreground">
                Retención IRPF ({i.withholdingPct} %) −{formatEur(i.withholdingAmount)} · a pagar{' '}
                {formatEur(i.amountDue)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Cobrado</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{formatEur(collected)}</p>
            {i.amountCompensated > 0 && (
              <p className="text-xs text-muted-foreground">
                Saldado con un abono {formatEur(i.amountCompensated)}
              </p>
            )}
            {i.amountRefunded > 0 && (
              <p className="text-xs text-muted-foreground">
                Devuelto {formatEur(i.amountRefunded)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Pendiente</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={`text-xl font-semibold tabular-nums ${
                i.amountPending > 0 ? 'text-destructive' : ''
              }`}
            >
              {formatEur(i.amountPending)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Fechas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0.5 text-sm">
            {isNumbered(i) ? (
              <p>Emitida: {formatDate(i.issueDate)}</p>
            ) : (
              <p>Creada: {formatDate(i.createdAt)}</p>
            )}
            {i.dueDate && i.total > 0 && (
              <p className="flex flex-wrap items-center gap-x-2">
                Vence: {formatDate(i.dueDate)}
                {canWriteInv && pendingStatus && (
                  <button
                    type="button"
                    aria-label="Cambiar el vencimiento"
                    className="text-xs text-primary underline-offset-2 hover:underline"
                    onClick={() => {
                      setDueDate(i.dueDate ?? undefined);
                      setDueReason('');
                      setDueOpen(true);
                    }}
                  >
                    Cambiar
                  </button>
                )}
              </p>
            )}
            {i.periodStart && i.periodEnd && (
              <p className="text-xs text-muted-foreground">
                Periodo: {formatDate(i.periodStart)} – {formatDate(i.periodEnd)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Líneas</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y md:hidden">
            {i.items.map((item) => (
              <li key={item.id} className="space-y-1 py-3 text-sm">
                <p className="font-medium">{item.description}</p>
                {item.periodStart && item.periodEnd && (
                  <p className="text-xs text-muted-foreground">
                    {formatDate(item.periodStart)} – {formatDate(item.periodEnd)}
                  </p>
                )}
                <div className="flex justify-between text-muted-foreground">
                  <span>
                    {item.quantity} × {formatEur(item.unitPrice)} ·{' '}
                    {item.taxCategory === 'S1'
                      ? `IVA ${item.taxRate} %`
                      : INVOICE_TAX_CATEGORY_LABELS[item.taxCategory]}
                  </span>
                  <span className="font-medium tabular-nums text-foreground">
                    {formatEur(item.total)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2">Concepto</th>
                  <th className="py-2 text-right">Cant.</th>
                  <th className="py-2 text-right">Precio</th>
                  <th className="py-2 text-right">IVA</th>
                  <th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {i.items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2">
                      {item.description}
                      {item.periodStart && item.periodEnd && (
                        <div className="text-xs text-muted-foreground">
                          {formatDate(item.periodStart)} – {formatDate(item.periodEnd)}
                        </div>
                      )}
                    </td>
                    <td className="py-2 text-right">{item.quantity}</td>
                    <td className="py-2 text-right">{formatEur(item.unitPrice)}</td>
                    <td className="py-2 text-right">
                      {item.taxCategory === 'S1'
                        ? `${item.taxRate} %`
                        : INVOICE_TAX_CATEGORY_LABELS[item.taxCategory]}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatEur(item.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {i.notes && (
            <p className="mt-3 whitespace-pre-line text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Notas: </span>
              {i.notes.replace(/^\[F2:[a-z_]+\]\s*/, '')}
            </p>
          )}
        </CardContent>
      </Card>

      {i.hash && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Veri*Factu</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              {i.qrCodeUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.qrCodeUrl} alt="QR Veri*Factu" className="size-32 rounded border" />
              )}
              <div className="min-w-0 space-y-1 text-xs">
                <p className="text-muted-foreground">Huella</p>
                <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-[10px]">
                  {i.hash}
                </code>
                {i.previousHash && (
                  <>
                    <p className="text-muted-foreground">Huella anterior</p>
                    <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-[10px]">
                      {i.previousHash}
                    </code>
                  </>
                )}
                {i.aeatCsv && <p>CSV de la AEAT: {i.aeatCsv}</p>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={dueOpen} onOpenChange={setDueOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar el vencimiento</DialogTitle>
            <DialogDescription>
              Por ejemplo, si el inquilino ha pedido unos días más. Si la nueva fecha es de hoy en
              adelante, la factura deja de estar vencida y se paran los recordatorios.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Nueva fecha</Label>
              <DateSelect value={dueDate} onChange={setDueDate} future />
            </div>
            <div className="space-y-1">
              <Label htmlFor="due-reason">Motivo</Label>
              <Input
                id="due-reason"
                value={dueReason}
                onChange={(e) => setDueReason(e.target.value.slice(0, 300))}
                placeholder="Ha pedido pagar a final de mes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDueOpen(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!dueDate || !dueReason.trim() || updateInvoice.isPending}
              onClick={() => {
                const next = dueDate;
                if (!next) return;
                void safe(async () => {
                  await updateInvoice.mutateAsync({
                    id: i.id,
                    input: { dueDate: next, dueDateReason: dueReason.trim() },
                  });
                  setDueOpen(false);
                }, 'Vencimiento cambiado.');
              }}
            >
              {updateInvoice.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={paidOpen} onOpenChange={setPaidOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Registrar cobro</DialogTitle>
            <DialogDescription>
              Pendiente: {formatEur(i.amountPending)}. Para dinero que ya has recibido.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="paid-amount">Importe (€)</Label>
              <Input
                id="paid-amount"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={paidAmount}
                onChange={(e) => setPaidAmount(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label>Forma de pago</Label>
              <Select
                value={paidMethod}
                onValueChange={(v) => setPaidMethod(v as typeof paidMethod)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(METHOD_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {i.offlinePaymentMethod && (
              <p className="text-xs text-muted-foreground">
                El inquilino eligió pagar{' '}
                {i.offlinePaymentMethod === 'bank_transfer'
                  ? 'por transferencia'
                  : i.offlinePaymentMethod === 'cash'
                    ? 'en el local'
                    : 'por domiciliación'}
                .
              </p>
            )}
            {paidMethod !== 'cash' && paidAmount > 0 && paidAmount < i.amountPending && (
              <p className="text-xs text-destructive">
                Solo en efectivo se admite pagar una parte. Por otra vía se registra todo lo
                pendiente.
              </p>
            )}
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={paidOverride}
                onChange={(e) => setPaidOverride(e.target.checked)}
              />
              <span>
                Registrarlo aunque haya un cobro con tarjeta o domiciliación en curso (solo si sabes
                que ese cobro no va a entrar).
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaidOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() =>
                safe(async () => {
                  await markPaid.mutateAsync({
                    id: i.id,
                    body: {
                      amount: paidAmount,
                      methodType: paidMethod,
                      ...(paidOverride ? { overridePaymentInFlight: true } : {}),
                    },
                  });
                  setPaidOpen(false);
                  setPaidOverride(false);
                }, 'Cobro registrado.')
              }
              disabled={paidAmount <= 0 || paidAmount > i.amountPending || markPaid.isPending}
            >
              {markPaid.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rectifyOpen} onOpenChange={setRectifyOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="pr-6">Rectificar la factura {i.invoiceNumber}</DialogTitle>
            <DialogDescription>
              Se crea una factura rectificativa en borrador. Al emitirla se envía a la AEAT.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label>Motivo legal</Label>
                <Select
                  value={rectifyType}
                  onValueChange={(v) => setRectifyType(v as RectificationTypeValue)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(RECTIFICATION_TYPE_LABELS) as RectificationTypeValue[]).map(
                      (key) => (
                        <SelectItem key={key} value={key}>
                          {RECTIFICATION_TYPE_LABELS[key]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rect-reason">Qué se corrige</Label>
                <Input
                  id="rect-reason"
                  value={rectifyReason}
                  onChange={(e) => setRectifyReason(e.target.value.slice(0, 500))}
                  placeholder="NIF equivocado, importe mal puesto…"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Cómo se corrige</Label>
              <div className="space-y-2 rounded border p-3 text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="correctionMethod"
                    className="mt-1"
                    checked={rectifyMethod === 'by_differences'}
                    onChange={() => {
                      setRectifyMethod('by_differences');
                      setRectifyItems(rectifyStart(i, 'by_differences'));
                    }}
                  />
                  <span>
                    <span className="font-medium">Por diferencias</span>
                    <span className="block text-xs text-muted-foreground">
                      Solo lo que cambia: en negativo lo que se resta. De entrada viene todo en
                      negativo (deja la factura a cero); quita o cambia las líneas que no toquen.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="correctionMethod"
                    className="mt-1"
                    checked={rectifyMethod === 'by_substitution'}
                    onChange={() => {
                      setRectifyMethod('by_substitution');
                      setRectifyItems(rectifyStart(i, 'by_substitution'));
                    }}
                  />
                  <span>
                    <span className="font-medium">Por sustitución</span>
                    <span className="block text-xs text-muted-foreground">
                      La factura entera con los importes correctos: sustituye a la original. Solo si
                      aún no se ha cobrado nada.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Líneas</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setRectifyItems((curr) => [
                      ...curr,
                      { description: '', quantity: 1, unitPrice: 0, taxRate: 21 },
                    ])
                  }
                >
                  <Plus className="mr-1 h-3 w-3" /> Añadir línea
                </Button>
              </div>
              <ul className="space-y-3">
                {rectifyItems.map((it, idx) => (
                  <li key={idx} className="space-y-2 rounded border p-2">
                    <div className="flex gap-2">
                      <Input
                        aria-label="Concepto"
                        placeholder="Concepto"
                        value={it.description}
                        onChange={(e) =>
                          setRectifyItems((curr) =>
                            curr.map((row, n) =>
                              n === idx ? { ...row, description: e.target.value } : row,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Quitar línea"
                        disabled={rectifyItems.length === 1}
                        onClick={() =>
                          setRectifyItems((curr) => curr.filter((_row, n) => n !== idx))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Cantidad</Label>
                        <Input
                          type="number"
                          step="1"
                          min="1"
                          inputMode="numeric"
                          value={it.quantity}
                          onChange={(e) =>
                            setRectifyItems((curr) =>
                              curr.map((row, n) =>
                                n === idx ? { ...row, quantity: Number(e.target.value) } : row,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Precio (€)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={it.unitPrice}
                          onChange={(e) =>
                            setRectifyItems((curr) =>
                              curr.map((row, n) =>
                                n === idx ? { ...row, unitPrice: Number(e.target.value) } : row,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">IVA (%)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          inputMode="decimal"
                          value={it.taxRate}
                          onChange={(e) =>
                            setRectifyItems((curr) =>
                              curr.map((row, n) =>
                                n === idx ? { ...row, taxRate: Number(e.target.value) } : row,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-right text-sm tabular-nums">
                Total de la rectificativa:{' '}
                <span className="font-semibold">{formatEur(rectifyTotal)}</span>
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRectifyOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() =>
                safe(async () => {
                  const created = await rectify.mutateAsync({
                    id: i.id,
                    input: {
                      rectificationType: rectifyType,
                      correctionMethod: rectifyMethod,
                      reason: rectifyReason.trim(),
                      items: rectifyItems.map((it) => ({
                        description: it.description,
                        quantity: it.quantity,
                        unitPrice: it.unitPrice,
                        taxRate: it.taxRate,
                        taxCategory:
                          it.taxRate === 0
                            ? it.taxCategory && it.taxCategory !== 'S1'
                              ? it.taxCategory
                              : 'N1'
                            : 'S1',
                      })),
                    },
                  });
                  setRectifyOpen(false);
                  router.push(`/invoices/${created.id}`);
                }, 'Rectificativa creada en borrador.')
              }
              disabled={rectify.isPending || !rectifyValid}
            >
              {rectify.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Crear rectificativa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Devolver dinero</DialogTitle>
            <DialogDescription>
              Si se cobró con tarjeta o domiciliación, se devuelve por la misma vía. Si se cobró en
              efectivo o por transferencia, aquí solo se registra: el dinero lo devuelves tú. Se
              emite una rectificativa por lo devuelto.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="refund-amount">Importe (€)</Label>
              <Input
                id="refund-amount"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={refundAmount}
                onChange={(e) => setRefundAmount(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Como mucho {formatEur(refundable)} (lo cobrado menos lo ya devuelto).
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="refund-reason">Motivo</Label>
              <Input
                id="refund-reason"
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={refund.isPending || refundAmount <= 0 || refundAmount > refundable}
              onClick={() => void submitRefund()}
            >
              {refund.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Devolver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
