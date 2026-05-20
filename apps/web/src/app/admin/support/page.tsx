'use client';

import { type SupportTicketPriorityValue, type SupportTicketStatusValue } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminSupportTickets } from '@/lib/admin/hooks';

const STATUS_LABELS: Record<
  SupportTicketStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  open: { label: 'Abierto', variant: 'destructive' },
  in_progress: { label: 'En curso', variant: 'default' },
  waiting_user: { label: 'Esperando cliente', variant: 'secondary' },
  resolved: { label: 'Resuelto', variant: 'outline' },
  closed: { label: 'Cerrado', variant: 'outline' },
};

const PRIORITY_LABELS: Record<SupportTicketPriorityValue, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente',
};

export default function AdminSupportPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SupportTicketStatusValue | undefined>();
  const [priority, setPriority] = useState<SupportTicketPriorityValue | undefined>();
  const [search, setSearch] = useState('');

  const tickets = useAdminSupportTickets({
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
  });

  if (tickets.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const term = search.trim().toLowerCase();
  const filtered = (tickets.data ?? []).filter((t) => {
    if (!term) return true;
    return (
      t.subject.toLowerCase().includes(term) ||
      t.tenantName.toLowerCase().includes(term) ||
      t.tenantSlug.toLowerCase().includes(term)
    );
  });

  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Soporte</h1>
        <p className="text-sm text-muted-foreground">
          Tickets de todos los tenants. Asígnatelos o transiciónalos según corresponda.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por asunto o tenant..."
          className="max-w-sm"
        />
        <Select
          value={status ?? 'all'}
          onValueChange={(v) =>
            setStatus(v === 'all' ? undefined : (v as SupportTicketStatusValue))
          }
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as SupportTicketStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={priority ?? 'all'}
          onValueChange={(v) =>
            setPriority(v === 'all' ? undefined : (v as SupportTicketPriorityValue))
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Prioridad" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            {(Object.keys(PRIORITY_LABELS) as SupportTicketPriorityValue[]).map((p) => (
              <SelectItem key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No hay tickets que coincidan con el filtro.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <ul className="divide-y">
            {filtered.map((t) => {
              const s = STATUS_LABELS[t.status];
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => router.push(`/admin/support/${t.id}`)}
                    className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{t.subject}</span>
                        <Badge variant={s.variant}>{s.label}</Badge>
                        <Badge variant="outline">{PRIORITY_LABELS[t.priority]}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t.tenantName} · {t.tenantSlug} ·{' '}
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
      )}
    </div>
  );
}
