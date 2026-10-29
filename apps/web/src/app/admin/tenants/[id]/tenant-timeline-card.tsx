'use client';

import {
  CalendarClock,
  CreditCard,
  Eye,
  FileText,
  LifeBuoy,
  Loader2,
  Mail,
  MessageSquare,
  ShieldCheck,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import type { AdminTimelineItemDto, AdminTimelineKind } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminTenantTimeline } from '@/lib/admin/hooks';
import { cn } from '@/lib/utils';

const FILTERS: { label: string; kinds: AdminTimelineKind[] }[] = [
  { label: 'Todo', kinds: [] },
  { label: 'Conversaciones', kinds: ['interaction'] },
  { label: 'Tickets', kinds: ['ticket'] },
  { label: 'Pagos y facturas', kinds: ['payment', 'invoice'] },
  { label: 'Acciones del admin', kinds: ['admin_action', 'impersonation'] },
  { label: 'Correos', kinds: ['email'] },
  { label: 'Seguimientos', kinds: ['followup'] },
  { label: 'Hitos', kinds: ['milestone'] },
];

const ICONS: Record<AdminTimelineKind, React.ComponentType<{ className?: string }>> = {
  interaction: MessageSquare,
  admin_action: ShieldCheck,
  impersonation: Eye,
  payment: CreditCard,
  invoice: FileText,
  ticket: LifeBuoy,
  email: Mail,
  followup: CalendarClock,
  milestone: Trophy,
};

const TONE: Record<AdminTimelineItemDto['tone'], string> = {
  neutral: 'bg-muted text-muted-foreground',
  positive: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  negative: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

/**
 * Historial del tenant en un solo sitio: conversaciones, tickets, pagos y
 * facturas de la suscripción, acciones del super admin, impersonaciones,
 * correos de la plataforma y seguimientos.
 */
export function TenantTimelineCard({ tenantId }: { tenantId: string }) {
  const [filter, setFilter] = useState(0);
  const kinds = FILTERS[filter]?.kinds ?? [];
  const q = useAdminTenantTimeline(tenantId, kinds);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="text-base">Historial</CardTitle>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f, i) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setFilter(i)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                i === filter
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <AdminError onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Sin eventos.</p>
        ) : (
          <ol className="relative space-y-4 border-l pl-6">
            {items.map((it) => {
              const Icon = ICONS[it.kind];
              const title = it.link ? (
                <Link href={it.link} className="hover:underline">
                  {it.title}
                </Link>
              ) : (
                it.title
              );
              return (
                <li key={it.id} className="relative">
                  <span
                    className={cn(
                      'absolute -left-[37px] flex size-6 items-center justify-center rounded-full ring-4 ring-background',
                      TONE[it.tone],
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-sm font-medium">{title}</p>
                    <time className="shrink-0 text-xs text-muted-foreground">
                      {new Date(it.at).toLocaleString('es-ES', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </div>
                  {it.detail && (
                    <p className="whitespace-pre-line text-sm text-muted-foreground">{it.detail}</p>
                  )}
                  {it.actor && <p className="text-xs text-muted-foreground">{it.actor}</p>}
                </li>
              );
            })}
          </ol>
        )}
        {q.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? 'Cargando…' : 'Ver más'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
