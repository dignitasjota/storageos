'use client';

import { type SupportTicketPriorityValue, type SupportTicketStatusValue } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type AdminSupportFilters, useAdminSupportTickets } from '@/lib/admin/hooks';

export const TICKET_STATUS_LABELS: Record<
  SupportTicketStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  open: { label: 'Abierto', variant: 'destructive' },
  in_progress: { label: 'En curso', variant: 'default' },
  waiting_user: { label: 'Esperando cliente', variant: 'secondary' },
  resolved: { label: 'Resuelto', variant: 'outline' },
  closed: { label: 'Cerrado', variant: 'outline' },
};

export const TICKET_PRIORITY_LABELS: Record<SupportTicketPriorityValue, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

/**
 * Lista de tickets de soporte paginada por cursor. La usan la bandeja global
 * `/admin/support` y la pestaña «Tickets» de la ficha del tenant.
 */
export function SupportTicketList({
  filters,
  showTenant = true,
  emptyText = 'No hay tickets que coincidan con el filtro.',
}: {
  filters: AdminSupportFilters;
  showTenant?: boolean;
  emptyText?: string;
}) {
  const router = useRouter();
  const tickets = useAdminSupportTickets(filters);

  if (tickets.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const rows = tickets.data?.pages.flatMap((p) => p.items) ?? [];
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border bg-card">
        <ul className="divide-y">
          {rows.map((t) => {
            const s = TICKET_STATUS_LABELS[t.status];
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/admin/support/${t.id}`)}
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{t.subject}</span>
                      <Badge variant={s.variant}>{s.label}</Badge>
                      <Badge variant="outline">{TICKET_PRIORITY_LABELS[t.priority]}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {showTenant ? `${t.tenantName} · ${t.tenantSlug} · ` : ''}
                      {new Date(t.createdAt).toLocaleString('es-ES')}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    {t.assignedAdminName ? (
                      <span>Asignado a {t.assignedAdminName}</span>
                    ) : (
                      <span className="italic">Sin asignar</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {tickets.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void tickets.fetchNextPage()}
            disabled={tickets.isFetchingNextPage}
          >
            {tickets.isFetchingNextPage && <Loader2 className="mr-2 size-4 animate-spin" />}
            Cargar más
          </Button>
        </div>
      )}
    </div>
  );
}
