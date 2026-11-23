'use client';

import type { ReactNode } from 'react';

import { AdminError } from '@/components/admin/admin-error';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminTenantSummary } from '@/lib/admin/hooks';
import { cn } from '@/lib/utils';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

function ago(iso: string | null): string {
  if (!iso) return 'nunca';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  return `hace ${days} d`;
}

const MODE_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  manual: 'Manual',
  sepa: 'SEPA',
  redsys: 'Tarjeta (Redsys)',
};

/**
 * Resumen de un vistazo del tenant: lo que aporta, cómo paga, si el equipo
 * entra, cómo factura a sus inquilinos y lo pendiente con soporte.
 */
export function TenantSummaryCard({ tenantId }: { tenantId: string }) {
  const q = useAdminTenantSummary(tenantId);
  const s = q.data;

  if (q.isLoading) {
    return <Skeleton className="h-28 w-full rounded-xl" />;
  }
  if (q.isError) return <AdminError onRetry={() => void q.refetch()} />;
  if (!s) return null;

  const loginDays = s.lastTeamLoginAt
    ? Math.floor((Date.now() - new Date(s.lastTeamLoginAt).getTime()) / 86_400_000)
    : null;

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 py-4 text-sm sm:grid-cols-3 2xl:grid-cols-6">
        <Item label="Aporta al mes (sin IVA)">
          {s.billingExempt ? (
            <span className="text-violet-700 dark:text-violet-300">Exenta</span>
          ) : (
            eur(s.effectiveMonthly)
          )}
          <Sub>
            {s.planName ?? 'Sin plan'}
            {s.wouldPay !== null ? ` · pagaría ${eur(s.wouldPay)}` : ''}
          </Sub>
        </Item>
        <Item label="Cobro">
          {s.billingMode ? (MODE_LABELS[s.billingMode] ?? s.billingMode) : '—'}
          <Sub>
            {s.trialEndsAt
              ? `prueba hasta ${fmtDate(s.trialEndsAt)}`
              : s.nextChargeAt
                ? `pagado hasta ${fmtDate(s.nextChargeAt)}`
                : 'sin cobro programado'}
          </Sub>
        </Item>
        <Item label="Equipo" warn={loginDays === null || loginDays > 14}>
          {s.activeUsers} {s.activeUsers === 1 ? 'usuario' : 'usuarios'}
          <Sub>último acceso {ago(s.lastTeamLoginAt)}</Sub>
        </Item>
        <Item label="Facturado 30 d">
          {eur(s.invoiced30d)}
          <Sub>
            {s.invoices30d} {s.invoices30d === 1 ? 'factura' : 'facturas'} · cobrado{' '}
            {eur(s.collected30d)}
          </Sub>
        </Item>
        <Item label="Vencidas" danger={s.overdueInvoices > 0}>
          {s.overdueInvoices > 0 ? eur(s.overdueAmount) : 'Ninguna'}
          <Sub>
            {s.activeContracts} contratos vigentes
            {s.occupancyPct !== null ? ` · ${s.occupancyPct} % ocupado` : ''}
          </Sub>
        </Item>
        <Item label="Soporte" warn={s.openTickets > 0}>
          {s.openTickets > 0 ? `${s.openTickets} ticket(s) abiertos` : 'Sin tickets'}
          <Sub>
            {s.nextFollowup ? (
              <span
                className={
                  s.nextFollowup.dueDate <= new Date().toISOString().slice(0, 10)
                    ? 'font-medium text-red-600 dark:text-red-400'
                    : undefined
                }
              >
                seguimiento {fmtDate(s.nextFollowup.dueDate)}
              </span>
            ) : (
              `última conversación ${ago(s.lastInteractionAt)}`
            )}
          </Sub>
        </Item>
      </CardContent>
    </Card>
  );
}

function Item({
  label,
  children,
  warn,
  danger,
}: {
  label: string;
  children: ReactNode;
  warn?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'font-semibold',
          danger && 'text-red-600 dark:text-red-400',
          !danger && warn && 'text-amber-600 dark:text-amber-400',
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <div className="text-xs font-normal text-muted-foreground">{children}</div>;
}
