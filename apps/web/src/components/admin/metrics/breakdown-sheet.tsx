'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { type BreakdownParams, useMetricBreakdown } from '@/lib/admin/metrics-insights-hooks';
import { formatEur, plural } from '@/lib/format';

const STATUS_LABELS: Record<string, string> = {
  trial: 'En prueba',
  active: 'Activo',
  past_due: 'Pago atrasado',
  read_only: 'Solo lectura',
  suspended: 'Suspendido',
  cancelled: 'Cancelado',
};

const BreakdownContext = createContext<(params: BreakdownParams) => void>(() => undefined);

/** Abre el panel con los tenants que forman una cifra. */
export function useOpenBreakdown(): (params: BreakdownParams) => void {
  return useContext(BreakdownContext);
}

/**
 * Las cifras de Métricas son clicables: cada una abre un panel lateral con los
 * tenants que la forman y el enlace a su ficha.
 */
export function BreakdownProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useState<BreakdownParams | null>(null);
  const open = useCallback((p: BreakdownParams) => setParams(p), []);
  const value = useMemo(() => open, [open]);
  const q = useMetricBreakdown(params);
  const d = q.data;
  return (
    <BreakdownContext.Provider value={value}>
      {children}
      <Sheet open={!!params} onOpenChange={(o) => !o && setParams(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{d?.title ?? 'Tenants'}</SheetTitle>
            <SheetDescription>
              {d
                ? `${plural(d.rows.length, 'tenant', 'tenants')} · ${formatEur(d.totalMrr)} al mes sin IVA`
                : 'Los tenants que forman esta cifra.'}
            </SheetDescription>
          </SheetHeader>
          {q.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : q.isError ? (
            <p className="py-6 text-sm text-muted-foreground">No hemos podido cargar la lista.</p>
          ) : d && d.rows.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No hay ningún tenant.</p>
          ) : (
            <ul className="mt-4 divide-y rounded-md border">
              {d?.rows.map((r) => (
                <li key={r.tenantId} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/tenants/${r.tenantId}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {[r.slug, STATUS_LABELS[r.status] ?? r.status, r.planName]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {r.detail && <p className="text-xs text-muted-foreground">{r.detail}</p>}
                  </div>
                  <span className="shrink-0 tabular-nums text-sm">{formatEur(r.mrr)}</span>
                </li>
              ))}
            </ul>
          )}
        </SheetContent>
      </Sheet>
    </BreakdownContext.Provider>
  );
}
