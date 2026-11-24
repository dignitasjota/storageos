'use client';

import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  SALES_ARCHIVE_FILTER_LABELS,
  SALES_ARCHIVE_FILTERS,
  type SalesArchiveFilter,
  type SalesLeadDto,
} from '@storageos/shared';
import { Ban, Loader2, RotateCcw, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Empty, errorText, QueryError, todayInSpain } from '@/components/admin/sales/common';
import { LeadCard } from '@/components/admin/sales/portfolio';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSalesLeads, useSalesRecover } from '@/lib/admin/sales-hooks';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

function RecoverButton({ lead }: { lead: SalesLeadDto }) {
  const recover = useSalesRecover(lead.id);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={recover.isPending}
      onClick={() =>
        void recover
          .mutateAsync(undefined)
          .then(() => toast.success(`${lead.displayName} vuelve a tu cartera.`))
          .catch((e) => toast.error(errorText(e)))
      }
    >
      {recover.isPending ? (
        <Loader2 className="mr-1.5 size-4 animate-spin" />
      ) : (
        <RotateCcw className="mr-1.5 size-4" />
      )}
      Recuperar
    </Button>
  );
}

/** Lo que dice de cada archivado: motivo y cuándo volver a intentarlo. */
function ArchiveLine({ lead }: { lead: SalesLeadDto }) {
  const today = todayInSpain();
  const due = !!lead.salesRecoverOn && lead.salesRecoverOn <= today;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      {lead.doNotContact ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-300">
          <Ban className="size-3" /> No volver a contactar
        </span>
      ) : due ? (
        <span className="rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-300">
          Para recuperar
        </span>
      ) : lead.salesRecoverOn ? (
        <span className="rounded-full bg-muted px-2 py-0.5">
          Volver a intentarlo el {formatDate(lead.salesRecoverOn)}
        </span>
      ) : (
        <span className="rounded-full bg-muted px-2 py-0.5">Sin fecha</span>
      )}
      {lead.lostReasonCode && (
        <span className="text-muted-foreground">
          {PLATFORM_LEAD_LOST_REASON_LABELS[lead.lostReasonCode]}
          {lead.salesArchivedAt && ` · archivado el ${formatDate(lead.salesArchivedAt)}`}
        </span>
      )}
    </div>
  );
}

/** «Archivados»: los no interesados y los clientes que se dieron de baja. */
export function ArchivedView({ initial = null }: { initial?: SalesArchiveFilter | null }) {
  const [filter, setFilter] = useState<SalesArchiveFilter | null>(initial);
  const [search, setSearch] = useState('');
  const leads = useSalesLeads({
    archived: true,
    ...(filter ? { archive: filter } : {}),
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
    sort: 'updated',
  });
  const first = leads.data?.pages[0];
  const items = leads.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = first?.archived;
  const countOf = (f: SalesArchiveFilter | null) =>
    !counts
      ? null
      : f === null
        ? counts.total
        : f === 'due'
          ? counts.due
          : f === 'scheduled'
            ? counts.scheduled
            : counts.doNotContact;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Siguen siendo tuyos y no se liberan por inactividad. Cuando llega la fecha, te salen en
        «Para recuperar» de tu «Hoy» y en «Por hacer».
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {([null, ...SALES_ARCHIVE_FILTERS] as (SalesArchiveFilter | null)[]).map((f) => (
            <button
              key={f ?? 'all'}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
                filter === f
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent/60',
              )}
            >
              {f ? SALES_ARCHIVE_FILTER_LABELS[f] : 'Todos'}
              {countOf(f) !== null && <span className="ml-1 tabular-nums">{countOf(f)}</span>}
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Buscar"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {leads.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : leads.isError ? (
        <QueryError query={leads} />
      ) : items.length === 0 ? (
        <Empty>
          {filter === 'due'
            ? 'No tienes ninguno para recuperar hoy.'
            : 'No tienes archivados aquí. «No interesado» en una ficha lo trae.'}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {items.map((lead) => (
            <li key={lead.id}>
              <LeadCard
                lead={lead}
                top={<ArchiveLine lead={lead} />}
                footer={
                  <div className="mt-2 flex flex-wrap gap-2">
                    <RecoverButton lead={lead} />
                  </div>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {leads.hasNextPage && (
        <div className="text-center">
          <Button
            variant="outline"
            disabled={leads.isFetchingNextPage}
            onClick={() => void leads.fetchNextPage()}
          >
            {leads.isFetchingNextPage && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Cargar más
          </Button>
        </div>
      )}
    </div>
  );
}
