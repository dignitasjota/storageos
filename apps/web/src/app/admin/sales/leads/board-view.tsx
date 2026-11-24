'use client';

import {
  PLATFORM_LEAD_MANUAL_STAGES,
  PLATFORM_LEAD_STAGE_LABELS,
  type PlatformLeadStage,
  type SalesLeadDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { toParams, type LeadListState } from './list-view';

import { errorText } from '@/components/admin/sales/common';
import { LeadCard } from '@/components/admin/sales/portfolio';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSalesBulk, useSalesLeads } from '@/lib/admin/sales-hooks';
import { formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Las columnas del tablero: las abiertas (prueba la marca su cuenta). */
const COLUMNS: PlatformLeadStage[] = ['new', 'contacted', 'interested', 'trial'];
const MOVABLE = new Set<string>(PLATFORM_LEAD_MANUAL_STAGES);
const DRAG_TYPE = 'application/x-sales-lead';

function Column({
  stage,
  state,
  onMove,
  dragging,
  setDragging,
}: {
  stage: PlatformLeadStage;
  state: LeadListState;
  onMove: (lead: SalesLeadDto, to: PlatformLeadStage) => void;
  dragging: SalesLeadDto | null;
  setDragging: (l: SalesLeadDto | null) => void;
}) {
  const params = useMemo(
    () => ({ ...toParams({ ...state, status: stage }, state.search) }),
    [state, stage],
  );
  const leads = useSalesLeads(params, { limit: 30 });
  const items = leads.data?.pages.flatMap((p) => p.items) ?? [];
  const total = leads.data?.pages[0]?.total ?? 0;
  const value = items.reduce((s, l) => s + (l.estimatedMonthly ?? 0), 0);
  const [over, setOver] = useState(false);
  const canDrop = !!dragging && MOVABLE.has(stage) && dragging.status !== stage;

  return (
    <section
      aria-label={PLATFORM_LEAD_STAGE_LABELS[stage]}
      className={cn(
        'flex w-[85vw] shrink-0 snap-start flex-col rounded-lg border bg-muted/40 sm:w-72',
        over && canDrop && 'border-primary bg-primary/5',
      )}
      onDragOver={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (dragging && canDrop) onMove(dragging, stage);
        setDragging(null);
      }}
    >
      <header className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{PLATFORM_LEAD_STAGE_LABELS[stage]}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {total}
          {value > 0 && ` · ≈ ${formatEur(value)}/mes`}
        </span>
      </header>
      <div className="flex-1 space-y-2 p-2">
        {leads.isLoading ? (
          <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Cargando…
          </div>
        ) : items.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">Nadie en esta fase.</p>
        ) : (
          items.map((l) => (
            <div
              key={l.id}
              draggable={MOVABLE.has(l.status)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, l.id);
                e.dataTransfer.effectAllowed = 'move';
                setDragging(l);
              }}
              onDragEnd={() => setDragging(null)}
              className={cn(MOVABLE.has(l.status) && 'cursor-grab active:cursor-grabbing')}
            >
              <LeadCard
                lead={l}
                footer={
                  MOVABLE.has(l.status) ? (
                    <Select
                      value={l.status}
                      onValueChange={(v) => onMove(l, v as PlatformLeadStage)}
                    >
                      <SelectTrigger className="mt-2 h-8 text-xs" aria-label="Mover a otra fase">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLATFORM_LEAD_MANUAL_STAGES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s === l.status
                              ? PLATFORM_LEAD_STAGE_LABELS[s]
                              : `Mover a ${PLATFORM_LEAD_STAGE_LABELS[s]}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null
                }
              />
            </div>
          ))
        )}
        {leads.hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={leads.isFetchingNextPage}
            onClick={() => void leads.fetchNextPage()}
          >
            {leads.isFetchingNextPage && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Cargar más
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Tablero por fases. En el ordenador se arrastra la tarjeta; en el móvil (o
 * con el teclado) se usa «Mover a…» de cada tarjeta.
 */
export function BoardView({ state }: { state: LeadListState }) {
  const move = useSalesBulk();
  const [dragging, setDragging] = useState<SalesLeadDto | null>(null);

  async function onMove(lead: SalesLeadDto, to: PlatformLeadStage) {
    if (lead.status === to || !MOVABLE.has(to)) return;
    try {
      const res = await move.mutateAsync({
        leadIds: [lead.id],
        action: { type: 'move', status: to as (typeof PLATFORM_LEAD_MANUAL_STAGES)[number] },
      });
      if (res.failed[0]) toast.error(res.failed[0].message);
      else toast.success(`${lead.displayName} pasa a ${PLATFORM_LEAD_STAGE_LABELS[to]}.`);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Por prioridad dentro de cada fase. Los que están en prueba se mueven solos con su cuenta;
        los clientes y los perdidos están en la lista.
      </p>
      <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {COLUMNS.map((stage) => (
          <Column
            key={stage}
            stage={stage}
            state={{ ...state, sort: 'priority', dir: 'desc' }}
            onMove={(l, to) => void onMove(l, to)}
            dragging={dragging}
            setDragging={setDragging}
          />
        ))}
      </div>
    </div>
  );
}
