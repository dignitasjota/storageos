'use client';

import { Building2, Clock, LifeBuoy, Loader2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useAdminSearch } from '@/lib/admin/hooks';
import { tenantStatusLabel } from '@/lib/admin/labels';
import { readRecentTenants, rememberTenant, type RecentTenant } from '@/lib/admin/recent-tenants';

interface Item {
  key: string;
  href: string;
  label: string;
  hint: string;
  kind: 'recent' | 'tenant' | 'ticket';
  tenant?: RecentTenant;
}

/**
 * Búsqueda global del panel admin (⌘K / Ctrl+K): tenants por nombre, slug,
 * NIF, emails, teléfono o dominio, y tickets por asunto. Sin texto, muestra
 * los últimos tenants abiertos.
 */
export function AdminCommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<RecentTenant[]>([]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setRecent(readRecentTenants());
      setQ('');
      setDebounced('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const search = useAdminSearch(debounced);
  const items = useMemo<Item[]>(() => {
    if (debounced.trim().length < 2) {
      return recent.map((r) => ({
        key: `r-${r.id}`,
        href: `/admin/tenants/${r.id}`,
        label: r.name,
        hint: 'Abierto hace poco',
        kind: 'recent',
        tenant: r,
      }));
    }
    const data = search.data;
    if (!data) return [];
    return [
      ...data.tenants.map((t) => ({
        key: `t-${t.id}`,
        href: `/admin/tenants/${t.id}`,
        label: t.name,
        hint: t.match ?? `${t.slug} · ${tenantStatusLabel(t.status)}`,
        kind: 'tenant' as const,
        tenant: { id: t.id, name: t.name },
      })),
      ...data.tickets.map((t) => ({
        key: `k-${t.id}`,
        href: `/admin/support/${t.id}`,
        label: t.subject,
        hint: `Ticket · ${t.tenantName}`,
        kind: 'ticket' as const,
      })),
    ];
  }, [debounced, recent, search.data]);

  useEffect(() => setActive(0), [items.length]);

  function go(item: Item | undefined) {
    if (!item) return;
    if (item.tenant) rememberTenant(item.tenant);
    setOpen(false);
    router.push(item.href);
  }

  const Icon = { recent: Clock, tenant: Building2, ticket: LifeBuoy };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground hover:bg-accent sm:inline-flex"
      >
        <Search className="size-4" /> Buscar
        <kbd className="rounded border bg-muted px-1.5 text-[10px]">⌘K</kbd>
      </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Buscar"
        className="inline-flex size-9 items-center justify-center rounded-full hover:bg-accent sm:hidden"
      >
        <Search className="size-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-lg">
          <DialogTitle className="sr-only">Buscar</DialogTitle>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, items.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  go(items[active]);
                }
              }}
              placeholder="Tenant, NIF, email, teléfono, dominio o ticket…"
              className="h-12 flex-1 bg-transparent text-base outline-none sm:text-sm"
            />
            {search.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>
          <div className="max-h-80 overflow-y-auto p-1">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {debounced.trim().length < 2
                  ? 'Escribe al menos 2 caracteres.'
                  : search.isFetching
                    ? 'Buscando…'
                    : 'Sin resultados.'}
              </p>
            ) : (
              items.map((it, i) => {
                const I = Icon[it.kind];
                return (
                  <button
                    key={it.key}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(it)}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${
                      i === active ? 'bg-accent' : ''
                    }`}
                  >
                    <I className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{it.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {it.hint}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
