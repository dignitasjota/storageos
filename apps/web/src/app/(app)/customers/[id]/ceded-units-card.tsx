'use client';

import { Handshake } from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDate } from '@/lib/format';
import { useCessions } from '@/lib/unit-cessions/hooks';

/** Trasteros que se le han cedido al inquilino (sin contrato ni cobro). Sin código. */
export function CededUnitsCard({ customerId }: { customerId: string }) {
  const canRead = useHasPermission('units:read');
  const cessions = useCessions({ customerId }, canRead);
  const items = cessions.data ?? [];
  if (items.length === 0) return null;

  return (
    <Card className="border-violet-200 dark:border-violet-900">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Handshake className="size-4 text-violet-600 dark:text-violet-400" />
          Trasteros cedidos
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2">
              <Link href={`/units/${c.unitId}`} className="font-medium hover:underline">
                {c.unitCode}
              </Link>
              <span className="text-muted-foreground">
                {c.facilityName} · hasta el {formatDate(c.endsOn)}
              </span>
              {c.expired && (
                <span className="font-medium text-rose-700 dark:text-rose-400">Vencida</span>
              )}
              {c.daysLeft === 0 && (
                <span className="font-medium text-amber-700 dark:text-amber-400">Vence hoy</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
