'use client';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminTenantSaasPayments, useSyncTenantSaasPayments } from '@/lib/admin/hooks';

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : '—';
}

function fmtMoney(amount: number, currency: string): string {
  return amount.toLocaleString('es-ES', { style: 'currency', currency: currency || 'EUR' });
}

/** Periodo cubierto + duración legible (p. ej. "1 mes", "1 año"). */
function fmtPeriod(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  const months = Math.max(1, Math.round((e.getTime() - s.getTime()) / (30.4 * 24 * 3600 * 1000)));
  const dur = months >= 12 ? `${Math.round(months / 12)} año(s)` : `${months} mes(es)`;
  return `${fmtDate(start)} → ${fmtDate(end)} · ${dur}`;
}

const STATUS_LABELS: Record<string, string> = {
  paid: 'Pagado',
  failed: 'Fallido',
  pending: 'Pendiente',
  void: 'Anulado',
};

export function SaasPaymentsCard({ tenantId }: { tenantId: string }) {
  const payments = useAdminTenantSaasPayments(tenantId);
  const sync = useSyncTenantSaasPayments();

  async function onSync() {
    try {
      const res = await sync.mutateAsync(tenantId);
      toast.success(`Sincronizados ${res.synced} pagos desde Stripe.`);
    } catch {
      toast.error('No se pudieron sincronizar los pagos.');
    }
  }

  const rows = payments.data ?? [];
  const totalPaid = rows.filter((p) => p.status === 'paid').reduce((s, p) => s + p.amount, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Historial de pagos (suscripción)</CardTitle>
        <Button variant="outline" size="sm" onClick={onSync} disabled={sync.isPending}>
          {sync.isPending ? 'Sincronizando…' : 'Sincronizar con Stripe'}
        </Button>
      </CardHeader>
      <CardContent>
        {payments.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin pagos registrados. Cada cobro de la suscripción (vía Stripe) se guardará aquí
            automáticamente; usa «Sincronizar» para traer los ya existentes.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Total cobrado:{' '}
              <span className="font-medium text-foreground">
                {fmtMoney(totalPaid, rows[0]?.currency ?? 'EUR')}
              </span>{' '}
              · {rows.length} pago(s)
            </p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Fecha</th>
                    <th className="p-2">Periodo</th>
                    <th className="p-2">Plan</th>
                    <th className="p-2 text-right">Importe</th>
                    <th className="p-2">Estado</th>
                    <th className="p-2">Factura</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 whitespace-nowrap">{fmtDate(p.paidAt ?? p.createdAt)}</td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {fmtPeriod(p.periodStart, p.periodEnd)}
                      </td>
                      <td className="p-2">{p.planName ?? p.planSlug ?? '—'}</td>
                      <td className="p-2 text-right tabular-nums">
                        {fmtMoney(p.amount, p.currency)}
                      </td>
                      <td className="p-2">{STATUS_LABELS[p.status] ?? p.status}</td>
                      <td className="p-2">
                        {p.invoiceUrl ? (
                          <a
                            href={p.invoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            Ver
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
