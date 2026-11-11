'use client';

import {
  CASH_DENOMINATIONS,
  denominationLabel,
  type CashDaySummaryDto,
  type CashLineDto,
} from '@storageos/shared';
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatDateTime, formatEur } from '@/lib/format';

/** Recuento por billetes y monedas: { "<céntimos>": unidades }. */
export type Denominations = Record<string, number>;

export function denominationsCents(d: Denominations): number {
  return Object.entries(d).reduce((sum, [k, n]) => sum + Number(k) * n, 0);
}

/**
 * Recuento por billetes y monedas: cada línea multiplica las unidades por su
 * valor y el total pasa a ser el efectivo contado.
 */
export function DenominationsInput({
  value,
  onChange,
}: {
  value: Denominations;
  onChange: (next: Denominations) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
      {CASH_DENOMINATIONS.map((d) => {
        const units = value[String(d)] ?? 0;
        return (
          <label key={d} className="flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
              {denominationLabel(d)}
            </span>
            <span className="text-muted-foreground">×</span>
            <Input
              inputMode="numeric"
              className="h-8 w-16 text-right"
              aria-label={`Unidades de ${denominationLabel(d)}`}
              value={units ? String(units) : ''}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, '') || 0);
                onChange({ ...value, [String(d)]: Math.min(n, 100_000) });
              }}
            />
          </label>
        );
      })}
    </div>
  );
}

const LINE_LABELS: Record<CashLineDto['kind'], string> = {
  payment: 'Cobro',
  refund: 'Devolución',
  deposit_return: 'Fianza devuelta',
};

/** Cada cobro, devolución o fianza en efectivo del día, con su inquilino y su factura. */
export function CashLinesCard({ summary }: { summary: CashDaySummaryDto }) {
  const [open, setOpen] = useState(false);
  const lines = summary.cashLines;
  if (lines.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <button
            type="button"
            className="flex items-center gap-1"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Efectivo del día, uno a uno ({lines.length})
            <ChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          <ul className="divide-y text-sm">
            {lines.map((l, k) => (
              <li key={`${l.kind}-${k}`} className="flex items-center justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  <p>
                    {LINE_LABELS[l.kind]}
                    {l.customerName && (
                      <>
                        {' · '}
                        {l.customerId ? (
                          <Link href={`/customers/${l.customerId}`} className="hover:underline">
                            {l.customerName}
                          </Link>
                        ) : (
                          l.customerName
                        )}
                      </>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {l.invoiceId ? (
                      <Link href={`/invoices/${l.invoiceId}`} className="hover:underline">
                        {l.invoiceNumber}
                      </Link>
                    ) : l.contractId ? (
                      <Link href={`/contracts/${l.contractId}`} className="hover:underline">
                        Ver el contrato
                      </Link>
                    ) : null}
                    {(l.invoiceId || l.contractId) && ' · '}
                    {formatDateTime(l.at)}
                  </p>
                </div>
                <span
                  className={`tabular-nums ${l.amount < 0 ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'}`}
                >
                  {formatEur(l.amount)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
