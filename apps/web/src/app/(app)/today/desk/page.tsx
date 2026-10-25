'use client';

import {
  ArrowLeft,
  ClipboardList,
  CreditCard,
  DoorOpen,
  FileSignature,
  LogIn,
  LogOut,
  Phone,
} from 'lucide-react';
import Link from 'next/link';

import type { TodayItemDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasFeature } from '@/lib/auth/hooks';
import { useToday } from '@/lib/dashboard/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';

type Kind = 'in' | 'out' | 'sign' | 'charge' | 'task' | 'call';

const KIND: Record<Kind, { label: string; icon: typeof LogIn; tint: string }> = {
  in: {
    label: 'Entra',
    icon: LogIn,
    tint: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  },
  out: {
    label: 'Sale',
    icon: LogOut,
    tint: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  sign: {
    label: 'Firma pendiente',
    icon: FileSignature,
    tint: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  charge: {
    label: 'Vence hoy',
    icon: CreditCard,
    tint: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  task: {
    label: 'Tarea',
    icon: ClipboardList,
    tint: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  call: {
    label: 'Llamar',
    icon: Phone,
    tint: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  },
};

interface AgendaRow {
  kind: Kind;
  item: TodayItemDto;
  href: string;
}

function eur(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

/**
 * «Hoy» para la tablet del mostrador: lo que pasa hoy en el local, en una sola
 * lista de botones grandes, con acceso directo a la puerta. Entradas y salidas
 * primero (es a quien vas a ver en persona), después firmas, cobros, tareas y
 * llamadas.
 */
export default function TodayDeskPage() {
  const facilityId = useHeaderFacilityId();
  const facilities = useFacilities();
  const today = useToday(facilityId);
  const hasAccess = useHasFeature('access_control');
  const data = today.data;
  const facilityName = facilityId
    ? facilities.data?.find((f) => f.id === facilityId)?.name
    : facilities.data?.length === 1
      ? facilities.data[0]?.name
      : null;

  const rows: AgendaRow[] = data
    ? [
        ...data.moveInsToday.items.map((item) => ({
          kind: 'in' as const,
          item,
          href: `/contracts/${item.id}`,
        })),
        ...data.moveOutsToday.items.map((item) => ({
          kind: 'out' as const,
          item,
          href: `/contracts/${item.id}`,
        })),
        ...data.signaturesPending.items.map((item) => ({
          kind: 'sign' as const,
          item,
          href: `/contracts/${item.id}`,
        })),
        ...(data.invoicesDueToday.items ?? []).map((item) => ({
          kind: 'charge' as const,
          item,
          href: `/invoices/${item.id}`,
        })),
        ...data.tasksDue.items.map((item) => ({
          kind: 'task' as const,
          item,
          href: `/tasks?task=${item.id}`,
        })),
        ...data.followupsDue.items.map((item) => ({
          kind: 'call' as const,
          item,
          href: item.linkId ? `/customers/${item.linkId}` : '/followups',
        })),
      ]
    : [];

  const rawDay = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {rawDay.charAt(0).toUpperCase() + rawDay.slice(1)}
          </h1>
          <p className="text-sm text-muted-foreground">
            {facilityName ?? 'Todos los locales'} · cambia el local en la cabecera
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/today">
              <ArrowLeft className="mr-1 size-4" /> Hoy
            </Link>
          </Button>
          {hasAccess && (
            <Button asChild size="lg">
              <Link href="/access/door">
                <DoorOpen className="mr-1 size-5" /> Puerta
              </Link>
            </Button>
          )}
        </div>
      </div>

      {!data ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Hoy no hay entradas, salidas, firmas ni tareas pendientes.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ kind, item, href }) => {
            const k = KIND[kind];
            const Icon = k.icon;
            return (
              <li key={`${kind}-${item.id}`}>
                <Link
                  href={href}
                  className="flex min-h-16 items-center gap-4 rounded-xl border bg-card px-4 py-3 shadow-card transition-colors hover:bg-muted active:bg-accent"
                >
                  <span
                    className={`flex size-11 shrink-0 items-center justify-center rounded-full ${k.tint}`}
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium">{item.label}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {k.label}
                      {item.detail ? ` · ${item.detail}` : ''}
                      {item.amount !== undefined ? ` · ${eur(item.amount)}` : ''}
                    </span>
                  </span>
                  {item.overdue && (
                    <span className="shrink-0 text-xs font-medium text-red-600">Atrasado</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
