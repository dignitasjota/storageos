'use client';

import { type SupportTicketPriorityValue, type SupportTicketStatusValue } from '@storageos/shared';
import { MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  formatDuration,
  SupportTicketList,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/components/admin/support-ticket-list';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminSupportStats } from '@/lib/admin/hooks';

export default function AdminSupportPage() {
  const [status, setStatus] = useState<SupportTicketStatusValue | undefined>();
  const [priority, setPriority] = useState<SupportTicketPriorityValue | undefined>();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  // La búsqueda va al servidor (la lista está paginada): debounce de 300 ms.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Soporte</h1>
          <p className="text-sm text-muted-foreground">
            Tickets de todos los tenants. Asígnatelos o transiciónalos según corresponda.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/support/canned">
            <MessageSquareText className="mr-2 size-4" />
            Respuestas guardadas
          </Link>
        </Button>
      </div>

      <SupportStats />

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
            {(Object.keys(TICKET_STATUS_LABELS) as SupportTicketStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {TICKET_STATUS_LABELS[s].label}
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
            {(Object.keys(TICKET_PRIORITY_LABELS) as SupportTicketPriorityValue[]).map((p) => (
              <SelectItem key={p} value={p}>
                {TICKET_PRIORITY_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SupportTicketList
        filters={{
          ...(status ? { status } : {}),
          ...(priority ? { priority } : {}),
          ...(debounced ? { search: debounced } : {}),
        }}
      />
    </div>
  );
}

/** Tiempos de primera respuesta de los últimos 30 días. */
function SupportStats() {
  const stats = useAdminSupportStats(30);
  const d = stats.data;
  if (!d) return null;
  const items = [
    {
      label: 'Mediana de 1.ª respuesta (30 días)',
      value:
        d.medianFirstResponseMinutes === null ? '—' : formatDuration(d.medianFirstResponseMinutes),
    },
    {
      label: 'Respondidos en menos de 24 h',
      value: d.answeredWithinDayPct === null ? '—' : `${d.answeredWithinDayPct} %`,
    },
    { label: 'Tickets abiertos (30 días)', value: String(d.ticketsOpened) },
    {
      label: 'Esperando primera respuesta',
      value:
        d.awaitingFirstResponse === 0
          ? '0'
          : `${d.awaitingFirstResponse} (el más antiguo, ${formatDuration((d.oldestAwaitingHours ?? 0) * 60)})`,
      warn: d.awaitingFirstResponse > 0,
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((i) => (
        <Card key={i.label}>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{i.label}</p>
            <p
              className={`mt-1 text-lg font-semibold ${
                i.warn ? 'text-amber-600 dark:text-amber-400' : ''
              }`}
            >
              {i.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
