'use client';

import { adminTodaySectionLabel, type AdminTodayVisitItemDto } from '@storageos/shared';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTodayVisit } from '@/lib/admin/hooks';

/** «hace 3 h», «hace 2 d». */
function since(iso: string): string {
  const hours = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
  return hours < 48 ? `hace ${hours} h` : `hace ${Math.floor(hours / 24)} d`;
}

function VisitList({
  title,
  count,
  items,
}: {
  title: string;
  count: number;
  items: AdminTodayVisitItemDto[];
}) {
  if (count === 0) return null;
  return (
    <details className="rounded-md border p-2">
      <summary className="cursor-pointer text-sm font-medium">
        {count} {title}
      </summary>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((i) => (
          <li key={i.key} className="flex items-center justify-between gap-2">
            <Link href={i.href} className="min-w-0 truncate hover:underline">
              {i.label}
            </Link>
            <span className="shrink-0 text-xs text-muted-foreground">
              {adminTodaySectionLabel(i.section)}
            </span>
          </li>
        ))}
        {count > items.length && (
          <li className="text-xs text-muted-foreground">y {count - items.length} más</li>
        )}
      </ul>
    </details>
  );
}

/**
 * «Desde tu última visita»: lo nuevo, lo resuelto y lo que ha empeorado. Se
 * pide una sola vez al abrir la página (el refresco de cada minuto no cuenta
 * como visita). No sale si entraste hace menos de una hora.
 */
export function TodayVisitCard() {
  const visit = useTodayVisit();
  const asked = useRef(false);
  const [closed, setClosed] = useState(false);
  const { mutate } = visit;

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    mutate();
  }, [mutate]);

  const v = visit.data;
  if (closed || !v || !v.show || !v.previousVisitAt) return null;
  if (v.newCount + v.resolvedCount + v.worseCount === 0) return null;
  return (
    <Card aria-live="polite">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm">
          Desde tu última visita ({since(v.previousVisitAt)})
        </CardTitle>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Cerrar el resumen"
          onClick={() => setClosed(true)}
        >
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {v.newCount} nuevos · {v.resolvedCount} resueltos · {v.worseCount} han empeorado
        </p>
        <div className="grid gap-2 md:grid-cols-3">
          <VisitList title="nuevos" count={v.newCount} items={v.newItems} />
          <VisitList title="resueltos" count={v.resolvedCount} items={v.resolvedItems} />
          <VisitList title="han empeorado" count={v.worseCount} items={v.worseItems} />
        </div>
      </CardContent>
    </Card>
  );
}
