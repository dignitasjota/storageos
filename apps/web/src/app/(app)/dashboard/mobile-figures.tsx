'use client';

import Link from 'next/link';

import { useHasPermission } from '@/lib/auth/hooks';
import { useTodaySummary } from '@/lib/dashboard/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatEur } from '@/lib/format';

function Tile({
  label,
  value,
  href,
  danger,
}: {
  label: string;
  value: string;
  href: string;
  danger?: boolean;
}) {
  return (
    <Link href={href} className="rounded-xl border border-border bg-card p-3 shadow-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${danger ? 'text-red-600' : ''}`}>
        {value}
      </p>
    </Link>
  );
}

/** Lo imprescindible del negocio encima de los accesos del móvil. */
export function MobileFigures() {
  const canSee = useHasPermission('contracts:read');
  const summary = useTodaySummary(useHeaderFacilityId(), canSee);
  const k = summary.data?.kpis;
  if (!k || k.totalUnits === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3">
      {k.moneyVisible && (
        <>
          <Tile label="Cobrado este mes" value={formatEur(k.collectedMonth)} href="/payments" />
          <Tile
            label="Vencido sin cobrar"
            value={formatEur(k.overduePending)}
            href="/arrears"
            danger={k.overduePending > 0}
          />
        </>
      )}
      <Tile label="Ocupación" value={`${k.occupancyPct}%`} href="/units" />
      <Tile label="Trasteros libres" value={`${k.freeUnits} de ${k.totalUnits}`} href="/units" />
    </div>
  );
}
