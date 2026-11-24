'use client';

import {
  SALES_ARCHIVE_FILTERS,
  SALES_LEAD_FILTERS,
  type SalesArchiveFilter,
  type SalesLeadFilter,
} from '@storageos/shared';
import { Archive, Columns3, FileUp, List, ListTodo, Loader2, PhoneCall, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { ArchivedView } from './archived-view';
import { BoardView } from './board-view';
import { ImportDialog } from './import-dialog';
import { EMPTY_LIST_STATE, ListView, type LeadListState } from './list-view';
import { QueueView } from './queue-view';

import { PageHeader, SalesPage } from '@/components/admin/sales/common';
import { NewProspectDialog } from '@/components/admin/sales/new-prospect-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type View = 'queue' | 'list' | 'board' | 'archived';

const VIEWS: { value: View; label: string; icon: typeof List }[] = [
  { value: 'queue', label: 'Por hacer', icon: ListTodo },
  { value: 'list', label: 'Lista', icon: List },
  { value: 'board', label: 'Tablero', icon: Columns3 },
  { value: 'archived', label: 'Archivados', icon: Archive },
];

export default function SalesLeadsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      }
    >
      <SalesLeads />
    </Suspense>
  );
}

function SalesLeads() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // El aviso de un reparto llega con `?filter=new_for_you&batch=…`: abre la lista.
  const [list, setList] = useState<LeadListState>(() => {
    const f = params.get('filter');
    return {
      ...EMPTY_LIST_STATE,
      filter:
        f && SALES_LEAD_FILTERS.includes(f as SalesLeadFilter) ? (f as SalesLeadFilter) : null,
      batch: params.get('batch'),
    };
  });
  const requested = params.get('view');
  const view: View =
    requested === 'list' ||
    requested === 'board' ||
    requested === 'queue' ||
    requested === 'archived'
      ? requested
      : params.get('filter') || params.get('batch')
        ? 'list'
        : 'queue';
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  function setView(v: View) {
    const next = new URLSearchParams(params.toString());
    next.set('view', v);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  return (
    <SalesPage>
      <PageHeader
        title="Prospectos"
        description="Tu cartera: lo que llevas tú, desde el primer contacto hasta que paga."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/admin/sales/leads/calls">
                <PhoneCall className="mr-1.5 size-4" />
                Modo llamadas
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <FileUp className="mr-1.5 size-4" />
              Importar
            </Button>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              Nuevo prospecto
            </Button>
          </>
        }
      />
      <NewProspectDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <div
        role="tablist"
        aria-label="Vista"
        className="grid grid-cols-2 rounded-lg border p-1 sm:inline-grid sm:w-auto sm:grid-cols-4"
      >
        {VIEWS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
              view === value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent/60',
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      {view === 'queue' && <QueueView />}
      {view === 'list' && <ListView state={list} onChange={setList} />}
      {view === 'board' && <BoardView state={EMPTY_LIST_STATE} />}
      {view === 'archived' && (
        <ArchivedView
          initial={
            SALES_ARCHIVE_FILTERS.includes(params.get('archive') as SalesArchiveFilter)
              ? (params.get('archive') as SalesArchiveFilter)
              : null
          }
        />
      )}
    </SalesPage>
  );
}
