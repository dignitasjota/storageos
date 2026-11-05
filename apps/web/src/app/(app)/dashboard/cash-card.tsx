'use client';

import { Wallet } from 'lucide-react';
import Link from 'next/link';

import type { DashboardCashDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur } from '@/lib/format';

function Row({
  label,
  amount,
  href,
  danger,
}: {
  label: string;
  amount: number;
  href: string;
  danger?: boolean;
}) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-2 py-2 hover:underline">
        <span>{label}</span>
        <span className={`font-medium tabular-nums ${danger ? 'text-red-600' : ''}`}>
          {formatEur(amount)}
        </span>
      </Link>
    </li>
  );
}

/** Cómo va el dinero del mes en curso, sea cual sea el periodo elegido. */
export function CashCard({
  data,
  loading,
  onRetry,
}: {
  data: DashboardCashDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-4 text-emerald-500" />
          Caja del mes
        </CardTitle>
        <CardDescription>Lo cobrado y lo que falta por entrar este mes.</CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-40">
          {(c) => (
            <>
              <ul className="divide-y text-sm">
                <Row label="Cobrado" amount={c.collected} href="/collections-month" />
                <Row label="Vence este mes" amount={c.dueThisMonth} href="/collections-month" />
                <Row label="Vencido sin cobrar" amount={c.overdue} href="/arrears" danger />
                <Row label="Vence más adelante" amount={c.dueLater} href="/invoices" />
              </ul>
              <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                Si se cobra lo que vence, cerrarás el mes con{' '}
                <span className="font-semibold tabular-nums">{formatEur(c.projected)}</span>.
              </p>
            </>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}
