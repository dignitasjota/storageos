'use client';

import { AlertTriangle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { useState } from 'react';

import type { AdminAccountEventDto, AdminScheduledChargeDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminTenantAccount } from '@/lib/admin/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

const METHOD: Record<string, string> = { stripe: 'Stripe', sepa: 'SEPA', manual: 'pago manual' };

const EVENT: Record<AdminAccountEventDto['kind'], { label: string; className: string }> = {
  payment: { label: 'Pago', className: 'text-emerald-700 dark:text-emerald-400' },
  failed: { label: 'Fallido', className: 'text-destructive' },
  refund: { label: 'Devolución', className: 'text-destructive' },
  bounce: { label: 'Devuelto', className: 'text-destructive' },
  invoice: { label: 'Factura', className: 'text-muted-foreground' },
  credit_note: { label: 'Rectificativa', className: 'text-muted-foreground' },
};

/**
 * Estado de cuenta del tenant con TrasterOS: si debe algo (y por dónde va el
 * escalado), el próximo cargo desglosado (plan + extras), los extras que se
 * cobran aparte y un historial único de pagos, facturas y devoluciones.
 */
export function TenantAccountCard({ tenantId }: { tenantId: string }) {
  const account = useAdminTenantAccount(tenantId);
  const [showAll, setShowAll] = useState(false);

  if (account.isLoading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  const a = account.data;
  if (!a) return null;
  const vat = a.pricesIncludeVat ? 'IVA incl.' : 'con IVA';
  const history = showAll ? a.history : a.history.slice(0, 8);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Estado de cuenta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {a.billingExempt ? (
          <p className="text-muted-foreground">Cuenta exenta: no se le cobra nada.</p>
        ) : a.overdue ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="flex-1 space-y-2">
                <p className="font-medium text-destructive">
                  Debe {eur(a.overdue.amount)} desde el {day(a.overdue.since)} ({a.overdue.days}{' '}
                  {a.overdue.days === 1 ? 'día' : 'días'})
                </p>
                {a.overdue.sepaInProgress && (
                  <p className="text-xs">
                    Hay un adeudo SEPA en el banco: no se le recuerda ni suspende mientras tanto.
                  </p>
                )}
                {a.overdue.sepaBounced && (
                  <p className="text-xs">El último adeudo SEPA se devolvió.</p>
                )}
                {a.overdue.steps.length > 0 ? (
                  <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {a.overdue.steps.map((s) => (
                      <li key={s.step} className="flex items-center gap-1">
                        {s.doneAt ? (
                          <CheckCircle2 className="size-3.5 text-destructive" />
                        ) : (
                          <Circle className="size-3.5 text-muted-foreground" />
                        )}
                        {s.label}: {s.doneAt ? `hecho el ${day(s.doneAt)}` : `el ${day(s.date)}`}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    El escalado automático está apagado (Facturación → Dunning SaaS).
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" /> Al día
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <ChargeBox
            title={a.overdue ? 'Cuota pendiente' : 'Próximo cargo de la cuota'}
            charge={a.nextCharge}
            empty={
              a.tenantStatus === 'trial'
                ? 'En prueba: aún no se le cobra.'
                : a.billingExempt
                  ? 'Exenta.'
                  : 'Sin cargos previstos.'
            }
            vat={vat}
            cycle={a.cycle}
          />
          <div className="rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">Extras que se cobran aparte</p>
            {a.addonCharges.length === 0 ? (
              <p className="mt-1 text-muted-foreground">Ninguno.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {a.addonCharges.map((c) => (
                  <li key={`${c.lines[0]?.label}-${c.date}`} className="flex justify-between gap-2">
                    <span>
                      {c.lines[0]?.label}{' '}
                      <span className="text-xs text-muted-foreground">· {day(c.date)}</span>
                    </span>
                    <span className="tabular-nums">{eur(c.total)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Pagado en los últimos 12 meses: {eur(a.paid12m)}
            </p>
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Movimientos</p>
          {a.history.length === 0 ? (
            <p className="text-muted-foreground">Sin pagos ni facturas todavía.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {history.map((e, i) => (
                <li
                  key={`${e.date}-${i}`}
                  className="flex items-start justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p>
                      <span className={`mr-2 text-xs font-medium ${EVENT[e.kind].className}`}>
                        {EVENT[e.kind].label}
                      </span>
                      {e.label}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {day(e.date)}
                      {e.detail ? ` · ${e.detail}` : ''}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 tabular-nums ${e.amount < 0 ? 'text-destructive' : ''}`}
                  >
                    {eur(e.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {a.history.length > 8 && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Ver menos' : `Ver los ${a.history.length}`}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ChargeBox({
  title,
  charge,
  empty,
  vat,
  cycle,
}: {
  title: string;
  charge: AdminScheduledChargeDto | null;
  empty: string;
  vat: string;
  cycle: 'monthly' | 'yearly' | null;
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {!charge ? (
        <p className="mt-1 text-muted-foreground">{empty}</p>
      ) : (
        <>
          <p className="mt-1">
            <span className="text-lg font-semibold">{eur(charge.total)}</span>{' '}
            <span className="text-xs text-muted-foreground">
              {vat} · {day(charge.date)} · {METHOD[charge.method] ?? charge.method}
              {cycle === 'yearly' ? ' · anual' : ''}
            </span>
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {charge.lines.map((l) => (
              <li key={l.label} className="flex justify-between gap-2">
                <span>{l.label}</span>
                <span className="tabular-nums">{eur(l.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
