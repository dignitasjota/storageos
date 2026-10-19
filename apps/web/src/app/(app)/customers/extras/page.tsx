'use client';

import { ArrowLeft, Check, Minus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { CustomerExtrasRowDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useCustomerExtras } from '@/lib/customers/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

type Col = {
  key: string;
  label: string;
  has: (r: CustomerExtrasRowDto) => boolean;
  text?: (r: CustomerExtrasRowDto) => string;
};

const COLS: Col[] = [
  {
    key: 'insured',
    label: 'Seguro',
    has: (r) => r.insuredContracts > 0,
    text: (r) => (r.contracts > 1 ? `${r.insuredContracts}/${r.contracts}` : ''),
  },
  { key: 'autopay', label: 'Cobro automático', has: (r) => r.autopay },
  {
    key: 'extra',
    label: 'Accesos extra',
    has: (r) => r.extraAccesses > 0,
    text: (r) => (r.extraAccesses > 0 ? String(r.extraAccesses) : ''),
  },
  {
    key: 'night',
    label: 'Pases nocturnos (90 d)',
    has: (r) => r.nightPasses90d > 0,
    text: (r) => (r.nightPasses90d > 0 ? String(r.nightPasses90d) : ''),
  },
  {
    key: 'shop',
    label: 'Tienda (12 m)',
    has: (r) => r.shop12m > 0,
    text: (r) => (r.shop12m > 0 ? eur(r.shop12m) : ''),
  },
  { key: 'portal', label: 'Portal con contraseña', has: (r) => r.portalPassword },
];

/**
 * Matriz inquilino × extras: qué tiene cada inquilino con contrato activo. Al
 * pulsar una columna se ven solo los que NO lo tienen (a quién ofrecérselo).
 */
export default function CustomerExtrasPage() {
  const extras = useCustomerExtras();
  const [missing, setMissing] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const d = extras.data;
  const rows = useMemo(() => {
    const col = COLS.find((c) => c.key === missing);
    const q = search.trim().toLowerCase();
    return (d?.rows ?? []).filter(
      (r) =>
        (!col || !col.has(r)) &&
        (!q ||
          r.customerName.toLowerCase().includes(q) ||
          r.units.join(' ').toLowerCase().includes(q)),
    );
  }, [d, missing, search]);
  const count = (key: string) =>
    (d?.rows ?? []).filter(COLS.find((c) => c.key === key)!.has).length;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/customers">
            <ArrowLeft className="mr-1 size-4" /> Inquilinos
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Extras por inquilino</h1>
        <p className="text-sm text-muted-foreground">
          Qué tiene contratado o usa cada inquilino activo. Pulsa una columna para ver a quién le
          falta.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {COLS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setMissing(missing === c.key ? null : c.key)}
            aria-pressed={missing === c.key}
            className={`h-9 rounded-md border px-3 text-sm ${missing === c.key ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
          >
            Sin {c.label.toLowerCase()} ({(d?.totals.customers ?? 0) - count(c.key)})
          </button>
        ))}
        <Input
          className="h-9 w-full sm:ml-auto sm:w-64"
          placeholder="Buscar inquilino o trastero…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {extras.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Cargando…</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {missing ? 'Todos lo tienen.' : 'No hay inquilinos con contrato activo.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Inquilino</th>
                  <th className="px-3 py-3 text-right font-medium">Cuota/mes</th>
                  {COLS.map((c) => (
                    <th key={c.key} className="px-3 py-3 text-center font-medium">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.customerId}>
                    <td className="px-4 py-2">
                      <Link
                        href={`/customers/${r.customerId}`}
                        className="font-medium hover:underline"
                      >
                        {r.customerName}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {r.units.join(', ')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{eur(r.monthly)}</td>
                    {COLS.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-center">
                        {c.has(r) ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <Check className="size-4" aria-label="Sí" />
                            {c.text?.(r) && <span className="text-xs">{c.text(r)}</span>}
                          </span>
                        ) : (
                          <Minus
                            className="mx-auto size-4 text-muted-foreground/50"
                            aria-label="No"
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
