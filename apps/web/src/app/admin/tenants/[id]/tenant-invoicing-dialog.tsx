'use client';

import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAdminTenantInvoicing } from '@/lib/admin/hooks';

export function TenantInvoicingDialog({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const invoicing = useAdminTenantInvoicing(tenantId, open);
  const d = invoicing.data;

  const fmtMoney = (n: number) =>
    n.toLocaleString('es-ES', { style: 'currency', currency: d?.currency || 'EUR' });

  const maxInvoiced = d ? Math.max(1, ...d.monthly.map((m) => m.invoiced)) : 1;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Facturación del tenant</DialogTitle>
          <DialogDescription>
            Facturas que el tenant emite a sus inquilinos (el volumen de su negocio).
          </DialogDescription>
        </DialogHeader>

        {invoicing.isLoading || !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Kpi label="Facturado (total)" value={fmtMoney(d.totalInvoiced)} />
              <Kpi label="Cobrado" value={fmtMoney(d.totalCollected)} accent="emerald" />
              <Kpi
                label="Pendiente"
                value={fmtMoney(d.totalPending)}
                accent={d.totalPending > 0 ? 'amber' : undefined}
              />
              <Kpi label="Facturas" value={String(d.invoiceCount)} />
              <Kpi
                label="Vencidas"
                value={String(d.overdueCount)}
                accent={d.overdueCount > 0 ? 'red' : undefined}
              />
              <Kpi label="Ticket medio" value={fmtMoney(d.avgInvoice)} />
            </div>

            {/* Serie mensual */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">Últimos 12 meses</span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block size-2 rounded-sm bg-foreground/30" /> Facturado
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block size-2 rounded-sm bg-primary" /> Cobrado
                  </span>
                </span>
              </div>
              {d.totalInvoiced === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Este tenant aún no ha emitido facturas.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {d.monthly.map((m) => (
                    <div key={m.label} className="flex items-center gap-2 text-xs">
                      <span className="w-12 shrink-0 text-muted-foreground">{m.label}</span>
                      <div className="flex-1 space-y-0.5">
                        <div className="h-2 rounded-sm bg-muted">
                          <div
                            className="h-2 rounded-sm bg-foreground/30"
                            style={{ width: `${(m.invoiced / maxInvoiced) * 100}%` }}
                          />
                        </div>
                        <div className="h-1.5 rounded-sm bg-muted">
                          <div
                            className="h-1.5 rounded-sm bg-primary"
                            style={{ width: `${(m.collected / maxInvoiced) * 100}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-24 shrink-0 text-right tabular-nums">
                        {fmtMoney(m.invoiced)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'emerald' | 'amber' | 'red';
}) {
  const color =
    accent === 'emerald'
      ? 'text-emerald-600'
      : accent === 'amber'
        ? 'text-amber-600'
        : accent === 'red'
          ? 'text-red-600'
          : 'text-foreground';
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
