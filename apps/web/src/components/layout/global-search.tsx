'use client';

import { CreditCard, FileText, Search, Users, Warehouse } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { SearchResultDto, SearchResultType } from '@storageos/shared';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useGlobalSearch } from '@/lib/search/hooks';

const TYPE_ICON: Record<SearchResultType, typeof Users> = {
  customer: Users,
  contract: FileText,
  unit: Warehouse,
  invoice: CreditCard,
};

const TYPE_LABEL: Record<SearchResultType, string> = {
  customer: 'Inquilino',
  contract: 'Contrato',
  unit: 'Trastero',
  invoice: 'Factura',
};

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { data, isFetching } = useGlobalSearch(q);
  const results = data?.results ?? [];

  // Atajo Cmd/Ctrl+K para abrir.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function go(r: SearchResultDto) {
    setOpen(false);
    setQ('');
    router.push(r.href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted sm:w-56"
      >
        <Search className="size-4 shrink-0" />
        <span className="hidden flex-1 text-left sm:inline">Buscar…</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 text-[10px] font-medium sm:inline">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[20%] max-w-lg translate-y-0 gap-0 p-0">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Busca inquilinos, contratos, trasteros o facturas…"
              className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {q.trim().length < 2 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Escribe al menos 2 caracteres.
              </p>
            ) : results.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {isFetching ? 'Buscando…' : 'Sin resultados.'}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {results.map((r) => {
                  const Icon = TYPE_ICON[r.type];
                  return (
                    <li key={`${r.type}-${r.id}`}>
                      <button
                        type="button"
                        onClick={() => go(r)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        {r.detail && (
                          <span className="shrink-0 text-xs text-muted-foreground">{r.detail}</span>
                        )}
                        <span className="shrink-0 text-[10px] uppercase text-muted-foreground/70">
                          {TYPE_LABEL[r.type]}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
