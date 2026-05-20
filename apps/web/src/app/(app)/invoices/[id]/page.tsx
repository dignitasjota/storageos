'use client';

import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Send,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { InvoiceStatusBadge } from '@/components/invoice-status-badge';
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
import { VerifactuBadge } from '@/components/verifactu-badge';
import { ApiError } from '@/lib/auth/api';
import {
  useCancelInvoice,
  useChargeInvoice,
  useGenerateInvoicePdf,
  useInvoice,
  useIssueInvoice,
  useMarkInvoicePaid,
  useRefundInvoice,
} from '@/lib/billing/hooks';

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const invoice = useInvoice(id);

  const issue = useIssueInvoice();
  const cancel = useCancelInvoice();
  const refund = useRefundInvoice();
  const markPaid = useMarkInvoicePaid();
  const charge = useChargeInvoice();
  const generatePdf = useGenerateInvoicePdf();

  const [paidOpen, setPaidOpen] = useState(false);
  const [paidAmount, setPaidAmount] = useState(0);
  const [paidMethod, setPaidMethod] = useState<'cash' | 'bank_transfer' | 'card'>('cash');
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState(0);
  const [refundReason, setRefundReason] = useState('');

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
            </div>
            <p className="text-sm text-muted-foreground">
              <Link href={`/customers/${i.customerId}`} className="hover:underline">
                {i.customerName}
              </Link>
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
                  onClick={() =>
                    safe(() => charge.mutateAsync({ invoiceId: i.id, input: {} }), 'Cobro lanzado.')
                  }
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
