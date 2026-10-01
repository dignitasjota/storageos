'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { PlatformInvoiceDto } from '@storageos/shared';

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
import { Textarea } from '@/components/ui/textarea';
import {
  fetchPlatformInvoicePdf,
  useAdminTenantPlatformInvoices,
  useRectifyPlatformInvoice,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const STATUS: Record<string, { label: string; className: string }> = {
  issued: { label: 'Emitida', className: '' },
  rectified: {
    label: 'Sustituida',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  cancelled: {
    label: 'Abonada',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
};

/**
 * Facturas de suscripción del tenant (incluidas las rectificativas) con la
 * opción de rectificarlas: por sustitución (corrige los datos del cliente) o
 * con un abono parcial o total.
 */
export function PlatformInvoicesCard({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = useAdminTenantPlatformInvoices(tenantId);
  const [target, setTarget] = useState<PlatformInvoiceDto | null>(null);

  async function onDownload(id: string) {
    try {
      window.open(await fetchPlatformInvoicePdf(id), '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Sin PDF disponible');
    }
  }

  const rows = data ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Facturas de suscripción</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay facturas.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((inv) => {
              const rect = inv.invoiceType !== 'F1';
              const status = STATUS[inv.status] ?? { label: inv.status, className: '' };
              const credited = inv.rectifiedBy
                .filter((r) => r.correctionMethod === 'differences')
                .reduce((s, r) => s - r.total, 0);
              const canRectify = !rect && inv.status !== 'cancelled';
              return (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => void onDownload(inv.id)}
                      disabled={!inv.hasPdf}
                    >
                      {inv.fullNumber}
                    </button>{' '}
                    <span className="text-muted-foreground">
                      · {new Date(inv.issuedAt).toLocaleDateString('es-ES')} · {eur(inv.total)}
                    </span>
                    <div className="mt-0.5 flex flex-wrap gap-1 text-xs text-muted-foreground">
                      {rect ? (
                        <span>
                          Rectificativa {inv.invoiceType} (
                          {inv.correctionMethod === 'substitution' ? 'sustitución' : 'abono'}) de{' '}
                          {inv.rectifies?.fullNumber}
                        </span>
                      ) : (
                        <>
                          {inv.rectifiedBy.length > 0 && (
                            <span>
                              Rectificada por {inv.rectifiedBy.map((r) => r.fullNumber).join(', ')}
                            </span>
                          )}
                          {inv.missing.length > 0 && inv.status === 'issued' && (
                            <span className="text-amber-700 dark:text-amber-400">
                              Falta {inv.missing.join(' y ')}
                            </span>
                          )}
                          {credited > 0 && inv.status !== 'cancelled' && (
                            <span>Abonado {eur(credited)}</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!rect && <Badge className={status.className}>{status.label}</Badge>}
                    {canRectify && (
                      <Button size="sm" variant="outline" onClick={() => setTarget(inv)}>
                        Rectificar
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {target && (
        <RectifyDialog tenantId={tenantId} invoice={target} onClose={() => setTarget(null)} />
      )}
    </Card>
  );
}

function RectifyDialog({
  tenantId,
  invoice,
  onClose,
}: {
  tenantId: string;
  invoice: PlatformInvoiceDto;
  onClose: () => void;
}) {
  const rectify = useRectifyPlatformInvoice(tenantId);
  const credited = invoice.rectifiedBy
    .filter((r) => r.correctionMethod === 'differences')
    .reduce((s, r) => s - r.total, 0);
  const remaining = Math.round((invoice.total - credited) * 100) / 100;
  const canSubstitute =
    credited === 0 && !invoice.rectifiedBy.some((r) => r.correctionMethod === 'substitution');
  const [method, setMethod] = useState<'substitution' | 'differences'>(
    canSubstitute && invoice.missing.length > 0 ? 'substitution' : 'differences',
  );
  const [type, setType] = useState<'R4' | 'R1'>('R4');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');

  async function submit() {
    const parsed = amount.trim() ? Number(amount.replace(',', '.')) : undefined;
    try {
      const res = await rectify.mutateAsync({
        id: invoice.id,
        input: {
          method,
          rectificationType: type,
          reason,
          ...(method === 'differences' && parsed !== undefined ? { amount: parsed } : {}),
        },
      });
      toast.success(`Rectificativa ${res.fullNumber} emitida y enviada al tenant.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo rectificar.');
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rectificar {invoice.fullNumber}</DialogTitle>
          <DialogDescription>
            Se emite una factura rectificativa en su propia serie y se envía al tenant. La factura
            original no se modifica.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Qué quieres corregir</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="substitution" disabled={!canSubstitute}>
                  Datos del cliente (sustituye la factura, mismos importes)
                </SelectItem>
                <SelectItem value="differences">Importe (abono parcial o total)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {method === 'substitution'
                ? 'Usa los datos de facturación actuales del tenant: complétalos antes («Editar» en la ficha).'
                : `Abono en negativo. Puedes abonar hasta ${eur(remaining)}; si abonas todo, la factura queda anulada.`}
            </p>
          </div>
          {method === 'differences' && (
            <div className="space-y-1">
              <Label>Importe a abonar (IVA incluido)</Label>
              <Input
                inputMode="decimal"
                value={amount}
                placeholder={`Vacío = ${eur(remaining)} (todo)`}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label>Tipo de rectificativa</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="R4">R4 — resto de causas (lo habitual)</SelectItem>
                <SelectItem value="R1">R1 — error fundado en derecho / art. 80 LIVA</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Motivo</Label>
            <Textarea
              value={reason}
              rows={2}
              placeholder="p. ej. Faltaban el NIF y el domicilio del cliente"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={rectify.isPending || reason.trim().length < 3}
          >
            Emitir rectificativa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
