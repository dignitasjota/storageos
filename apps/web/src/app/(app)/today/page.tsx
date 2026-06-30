'use client';

import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  ClipboardList,
  CreditCard,
  MessageSquare,
  Replace,
} from 'lucide-react';
import Link from 'next/link';

import type { TodayItemDto } from '@storageos/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useToday } from '@/lib/dashboard/hooks';

function eur(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/** Una tarjeta de "pendientes" con su lista y enlace a la sección. */
function SectionCard({
  title,
  icon: Icon,
  count,
  items,
  href,
  itemHref,
  empty,
}: {
  title: string;
  icon: typeof ClipboardList;
  count: number;
  items: TodayItemDto[];
  href: string;
  itemHref: (id: string) => string;
  empty: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" /> {title}
          {count > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
              {count}
            </span>
          )}
        </CardTitle>
        <Link
          href={href}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Ver todo <ArrowRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li key={it.id}>
                <Link
                  href={itemHref(it.id)}
                  className="flex items-center justify-between gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{it.label}</span>
                    {it.detail && (
                      <span className="shrink-0 text-xs text-muted-foreground">{it.detail}</span>
                    )}
                  </span>
                  {it.date && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {fmtDate(it.date)}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Una métrica simple clicable (sin lista). */
function StatTile({
  label,
  value,
  icon: Icon,
  href,
  highlight,
}: {
  label: string;
  value: string;
  icon: typeof CreditCard;
  href: string;
  highlight?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className={highlight ? 'border-amber-300' : undefined}>
        <CardContent className="flex items-center gap-3 pt-6">
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-full ${highlight ? 'bg-amber-100 text-amber-600' : 'bg-muted text-muted-foreground'}`}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xl font-semibold tracking-tight">{value}</p>
            <p className="truncate text-xs text-muted-foreground">{label}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function TodayPage() {
  const { data, isLoading } = useToday();

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hoy</h1>
        <p className="text-sm text-muted-foreground">
          Lo que tu equipo debe atender de un vistazo.
        </p>
      </div>

      {isLoading || !data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Facturas vencidas"
              value={
                data.invoicesOverdue.count > 0
                  ? `${data.invoicesOverdue.count} · ${eur(data.invoicesOverdue.totalPending)}`
                  : '0'
              }
              icon={CreditCard}
              href="/invoices"
              highlight={data.invoicesOverdue.count > 0}
            />
            <StatTile
              label="Incidencias abiertas"
              value={String(data.incidentsOpen)}
              icon={AlertTriangle}
              href="/incidents"
              highlight={data.incidentsOpen > 0}
            />
            <StatTile
              label="Cambios de trastero"
              value={String(data.unitChangesPending)}
              icon={Replace}
              href="/unit-change-requests"
              highlight={data.unitChangesPending > 0}
            />
            <StatTile
              label="Mensajes sin leer"
              value={String(data.unreadMessages)}
              icon={MessageSquare}
              href="/customers"
              highlight={data.unreadMessages > 0}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <SectionCard
              title="Tareas para hoy"
              icon={ClipboardList}
              count={data.tasksDue.count}
              items={data.tasksDue.items}
              href="/tasks"
              itemHref={() => '/tasks'}
              empty="Sin tareas pendientes para hoy."
            />
            <SectionCard
              title="Contratos por vencer"
              icon={CalendarClock}
              count={data.contractsEndingSoon.count}
              items={data.contractsEndingSoon.items}
              href="/contracts"
              itemHref={(id) => `/contracts/${id}`}
              empty="Ningún contrato vence en 30 días."
            />
            <SectionCard
              title="Reservas que expiran"
              icon={CalendarClock}
              count={data.reservationsExpiring.count}
              items={data.reservationsExpiring.items}
              href="/reservations"
              itemHref={() => '/reservations'}
              empty="Ninguna reserva expira en 7 días."
            />
          </div>
        </>
      )}
    </div>
  );
}
