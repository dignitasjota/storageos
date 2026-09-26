'use client';

import { type SupportTicketPriorityValue, type SupportTicketStatusValue } from '@storageos/shared';
import { useEffect, useState } from 'react';

import {
  SupportTicketList,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/components/admin/support-ticket-list';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
