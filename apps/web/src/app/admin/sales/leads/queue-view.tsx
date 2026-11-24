'use client';

import { SALES_QUEUE_REASON_LABELS, SALES_QUEUE_REASONS } from '@storageos/shared';
import { Loader2, PhoneCall } from 'lucide-react';
import Link from 'next/link';

import { Empty, QueryError } from '@/components/admin/sales/common';
import { LeadCard, QueueReasonBadge } from '@/components/admin/sales/portfolio';
import { Button } from '@/components/ui/button';
import { useSalesQueue } from '@/lib/admin/sales-hooks';
import { formatDate } from '@/lib/format';

/** «Por hacer»: la cola del día con el motivo de cada uno. */
export function QueueView() {
  const queue = useSalesQueue();
  const data = queue.data;

  if (queue.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Cargando…
      </div>
    );
  }
  if (queue.isError || !data) return <QueryError query={queue} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
        <div className="flex flex-wrap gap-2 text-xs">
          {SALES_QUEUE_REASONS.filter((r) => data.counts[r] > 0).map((r) => (
            <span key={r} className="rounded-full bg-muted px-2 py-1">
              {SALES_QUEUE_REASON_LABELS[r]}: <strong>{data.counts[r]}</strong>
            </span>
          ))}
          {data.items.length === 0 && (
            <span className="text-muted-foreground">No tienes nada pendiente.</span>
          )}
        </div>
        {data.items.length > 0 && (
          <Button asChild className="w-full sm:w-auto">
            <Link href="/admin/sales/leads/calls">
              <PhoneCall className="mr-1.5 size-4" />
              Empezar a llamar
            </Link>
          </Button>
        )}
      </div>

      {data.items.length === 0 ? (
        <Empty>Todo al día. Revisa la lista para buscar a quién llamar.</Empty>
      ) : (
        <ol className="space-y-2">
          {data.items.map((item, i) => (
            <li key={`${item.lead.id}-${item.reason}`}>
              <LeadCard
                lead={item.lead}
                top={
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold tabular-nums text-muted-foreground">
                      {i + 1}.
                    </span>
                    <QueueReasonBadge reason={item.reason} />
                    <span className="text-muted-foreground">
                      {item.detail.split(': ').slice(1).join(': ') || item.detail}
                      {item.date &&
                        item.reason.startsWith('followup') &&
                        ` · ${formatDate(item.date)}`}
                    </span>
                  </div>
                }
              />
            </li>
          ))}
        </ol>
      )}
      {data.truncated && (
        <p className="text-center text-xs text-muted-foreground">
          Hay más en la cola: aquí salen los más urgentes y los nuevos de más valor.
        </p>
      )}
    </div>
  );
}
