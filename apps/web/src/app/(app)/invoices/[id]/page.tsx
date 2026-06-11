'use client';

import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Receipt,
  Send,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CorrectionMethodValue, InvoiceDto, RectificationTypeValue } from '@storageos/shared';

import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
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
import { ApiError } from '@/lib/auth/api';
import {
  useCancelInvoice,
  useChargeInvoice,
  useGenerateInvoicePdf,
  useInvoice,
  useIssueInvoice,
  useMarkInvoicePaid,
  useRectifyInvoice,
  useRefundInvoice,
} from '@/lib/billing/hooks';

/**
 * Etiquetas explicativas para cada tipo de factura rectificativa (RD
 * 1619/2012 art. 13). Se muestran en el select del modal "Rectificar" y
 * en el tooltip del badge cuando la factura es rectificativa.
 */
const RECTIFICATION_TYPE_LABELS: Record<RectificationTypeValue, string> = {
  R1: 'R1 - Error fundado en derecho',
  R2: 'R2 - Concurso de acreedores (art. 80.3 LIVA)',
  R3: 'R3 - Creditos incobrables (art. 80.4 LIVA)',
  R4: 'R4 - Rectificativa generica (art. 80.6 LIVA)',
  R5: 'R5 - Otros (descuentos por volumen, etc.)',
};

const RECTIFIABLE_STATUSES = new Set<InvoiceDto['status']>([
  'issued',
  'paid',
  'overdue',
  'refunded',
  'partially_refunded',
]);

interface RectifyDraftItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

export default function InvoiceDetailPage() {
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
  const rectify = useRectifyInvoice();

  const [paidOpen, setPaidOpen] = useState(false);
  const [paidAmount, setPaidAmount] = useState(0);
  const [paidMethod, setPaidMethod] = useState<'cash' | 'bank_transfer' | 'card'>('cash');
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState(0);
  const [refundReason, setRefundReason] = useState('');
  const [rectifyOpen, setRectifyOpen] = useState(false);
  const [rectifyType, setRectifyType] = useState<RectificationTypeValue>('R1');
  const [rectifyMethod, setRectifyMethod] = useState<CorrectionMethodValue>('by_differences');
  const [rectifyReason, setRectifyReason] = useState('');
  const [rectifyItems, setRectifyItems] = useState<RectifyDraftItem[]>([]);

  if (invoice.isLoading || !invoice.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const i = invoice.data;
  async function safe<T>(fn: () => Promise<T>, ok: string): Promise<void> {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleCharge(): Promise<void> {
    try {
      const payment = await charge.mutateAsync({ invoiceId: i.id, input: {} });
      if (payment.status === 'processing') {
        // SEPA: el banco liquida en 2-5 dias habiles; el estado final llega
        // por webhook y la factura se marcara pagada sola.
        toast.info('Cobro SEPA iniciado: el banco lo confirmará en 2-5 días hábiles.');
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
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="space-y-6 px-6 py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/invoices">
            <ArrowLeft className="mr-1 h-4 w-4" /> Facturas
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">{i.invoiceNumber}</h1>
              <InvoiceStatusBadge status={i.status} />
              <VerifactuBadge invoice={i} />
              {i.invoiceType !== 'F1' && (
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
                        {i.rectifiesInvoiceId && i.rectifiesInvoiceNumber && (
                          <p>
                            Rectifica a{' '}
                            <Link href={`/invoices/${i.rectifiesInvoiceId}`} className="underline">
                              {i.rectifiesInvoiceNumber}
                            </Link>
                          </p>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {i.customerId ? (
                <Link href={`/customers/${i.customerId}`} className="hover:underline">
                  {i.customerName ?? 'Cliente'}
                </Link>
              ) : (
                <span className="italic">Sin destinatario identificado (F2)</span>
              )}
              {i.contractNumber && ` · contrato ${i.contractNumber}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {i.status === 'draft' && (
              <Button
                onClick={() => safe(() => issue.mutateAsync({ id: i.id }), 'Factura emitida.')}
              >
                <Send className="mr-1 h-4 w-4" /> Emitir
              </Button>
            )}
            {(i.status === 'issued' || i.status === 'overdue') && (
              <>
                <Button
                  variant="outline"
                  onClick={() => void handleCharge()}
                  disabled={charge.isPending}
                >
                  Cobrar (auto)
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPaidAmount(i.amountPending);
                    setPaidMethod('cash');
                    setPaidOpen(true);
                  }}
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" /> Marcar pagada
                </Button>
              </>
            )}
            {(i.status === 'paid' || i.status === 'partially_refunded') && (
              <Button
                variant="outline"
                onClick={() => {
                  setRefundAmount(i.amountPaid - i.amountRefunded);
                  setRefundReason('');
                  setRefundOpen(true);
                }}
              >
                <Undo2 className="mr-1 h-4 w-4" /> Reembolsar
              </Button>
            )}
            {i.status !== 'paid' && i.status !== 'cancelled' && i.status !== 'refunded' && (
              <Button
                variant="destructive"
                onClick={() =>
                  safe(
                    () => cancel.mutateAsync({ id: i.id, body: { reason: 'manual' } }),
                    'Factura cancelada.',
                  )
                }
              >
                <Ban className="mr-1 h-4 w-4" /> Cancelar
              </Button>
            )}
            {(i.invoiceType === 'F1' || i.invoiceType === 'F2') &&
              RECTIFIABLE_STATUSES.has(i.status) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setRectifyType('R1');
                    setRectifyMethod('by_differences');
                    setRectifyReason('');
                    setRectifyItems(
                      i.items.map((it) => ({
                        description: it.description,
                        quantity: it.quantity,
                        unitPrice: it.unitPrice,
                        taxRate: it.taxRate,
                      })),
                    );
                    setRectifyOpen(true);
                  }}
                >
                  <Receipt className="mr-1 h-4 w-4" /> Rectificar
                </Button>
              )}
            {i.status !== 'draft' && (
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
                {i.pdfUrl ? 'Regenerar PDF' : 'Generar PDF'}
              </Button>
            )}
            {i.pdfUrl && (
              <Button asChild variant="outline">
                <a href={i.pdfUrl} target="_blank" rel="noreferrer">
                  <Download className="mr-1 h-4 w-4" /> Descargar
                </a>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{i.total.toFixed(2)} €</p>
            <p className="text-xs text-muted-foreground">IVA {i.taxAmount.toFixed(2)} €</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Cobrado</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{i.amountPaid.toFixed(2)} €</p>
            {i.amountRefunded > 0 && (
              <p className="text-xs text-muted-foreground">
                Reembolsado {i.amountRefunded.toFixed(2)} €
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
              {i.amountPending.toFixed(2)} €
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Vencimiento</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{i.dueDate ?? '—'}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Líneas</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2">Concepto</th>
                <th className="py-2 text-right">Cant.</th>
                <th className="py-2 text-right">P. unit</th>
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
                        Periodo: {item.periodStart} → {item.periodEnd}
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-right">{item.quantity}</td>
                  <td className="py-2 text-right">{item.unitPrice.toFixed(2)} €</td>
                  <td className="py-2 text-right">{item.taxRate}%</td>
                  <td className="py-2 text-right tabular-nums">{item.total.toFixed(2)} €</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {i.hash && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Verifactu</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              {i.qrCodeUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.qrCodeUrl} alt="QR Verifactu" className="size-32 rounded border" />
              )}
              <div className="space-y-1 text-xs">
                <p className="text-muted-foreground">Huella SHA-256</p>
                <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-[10px]">
                  {i.hash}
                </code>
                {i.previousHash && (
                  <>
                    <p className="text-muted-foreground">Hash anterior</p>
                    <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-[10px]">
                      {i.previousHash}
                    </code>
                  </>
                )}
                {i.aeatCsv && <p>CSV AEAT: {i.aeatCsv}</p>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={paidOpen} onOpenChange={setPaidOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marcar pago recibido</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Importe (€)</Label>
              <Input
                type="number"
                step="0.01"
                value={paidAmount}
                onChange={(e) => setPaidAmount(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Método</Label>
              <Select
                value={paidMethod}
                onValueChange={(v) => setPaidMethod(v as typeof paidMethod)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Efectivo</SelectItem>
                  <SelectItem value="bank_transfer">Transferencia</SelectItem>
                  <SelectItem value="card">Tarjeta</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
                    body: { amount: paidAmount, methodType: paidMethod },
                  });
                  setPaidOpen(false);
                }, 'Pago registrado.')
              }
              disabled={paidAmount <= 0}
            >
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rectifyOpen} onOpenChange={setRectifyOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Emitir factura rectificativa</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <Label>Tipo de rectificacion</Label>
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
              <div>
                <Label>Motivo (max 500)</Label>
                <Input
                  value={rectifyReason}
                  onChange={(e) => setRectifyReason(e.target.value.slice(0, 500))}
                  placeholder="NIF erroneo, importe equivocado..."
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Metodo de rectificacion</Label>
              <div className="space-y-2 rounded border p-3 text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="correctionMethod"
                    className="mt-1"
                    checked={rectifyMethod === 'by_differences'}
                    onChange={() => setRectifyMethod('by_differences')}
                  />
                  <span>
                    <span className="font-medium">Por diferencias</span>
                    <span className="block text-xs text-muted-foreground">
                      El total de la rectificativa sera la diferencia entre el nuevo importe y el
                      original. Usa signos negativos para reducir.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="correctionMethod"
                    className="mt-1"
                    checked={rectifyMethod === 'by_substitution'}
                    onChange={() => setRectifyMethod('by_substitution')}
                  />
                  <span>
                    <span className="font-medium">Por sustitucion</span>
                    <span className="block text-xs text-muted-foreground">
                      El nuevo importe sustituye al original. Indica los items con sus importes
                      finales (positivos).
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="space-y-2">
              <Label>
                {rectifyMethod === 'by_differences'
                  ? 'Lineas (por diferencias: signos negativos reducen importes; positivos los aumentan)'
                  : 'Lineas (por sustitucion: importes nuevos absolutos)'}
              </Label>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-1">Concepto</th>
                    <th className="py-1 text-right">Cant.</th>
                    <th className="py-1 text-right">P. unit (€)</th>
                    <th className="py-1 text-right">IVA %</th>
                  </tr>
                </thead>
                <tbody>
                  {rectifyItems.map((it, idx) => (
                    <tr key={idx} className="border-b last:border-0">
                      <td className="py-1">
                        <Input
                          value={it.description}
                          onChange={(e) =>
                            setRectifyItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, description: e.target.value } : row,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="py-1 text-right">
                        <Input
                          type="number"
                          step="1"
                          min="1"
                          value={it.quantity}
                          onChange={(e) =>
                            setRectifyItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, quantity: Number(e.target.value) } : row,
                              ),
                            )
                          }
                          className="w-20"
                        />
                      </td>
                      <td className="py-1 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={it.unitPrice}
                          onChange={(e) =>
                            setRectifyItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, unitPrice: Number(e.target.value) } : row,
                              ),
                            )
                          }
                          className="w-28"
                        />
                      </td>
                      <td className="py-1 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={it.taxRate}
                          onChange={(e) =>
                            setRectifyItems((curr) =>
                              curr.map((row, i) =>
                                i === idx ? { ...row, taxRate: Number(e.target.value) } : row,
                              ),
                            )
                          }
                          className="w-20"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground">
                La rectificativa se crea como borrador. Tendras que emitirla manualmente para que se
                envie a AEAT.
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
                      })),
                    },
                  });
                  setRectifyOpen(false);
                  router.push(`/invoices/${created.id}`);
                }, 'Factura rectificativa creada como borrador.')
              }
              disabled={
                rectify.isPending || rectifyReason.trim().length === 0 || rectifyItems.length === 0
              }
            >
              {rectify.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Crear rectificativa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reembolso</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Importe (€)</Label>
              <Input
                type="number"
                step="0.01"
                value={refundAmount}
                onChange={(e) => setRefundAmount(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Motivo</Label>
              <Input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                safe(async () => {
                  await refund.mutateAsync({
                    id: i.id,
                    body: { amount: refundAmount, reason: refundReason },
                  });
                  setRefundOpen(false);
                }, 'Reembolso registrado.')
              }
            >
              Reembolsar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
