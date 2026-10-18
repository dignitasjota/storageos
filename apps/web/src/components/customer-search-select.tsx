'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { CustomerDto, PageDto } from '@storageos/shared';

import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/auth/api';
import { useCustomer } from '@/lib/customers/hooks';
import { useDebouncedSearch } from '@/lib/pagination';

/**
 * Selector de inquilino con búsqueda en el servidor: con miles de inquilinos no
 * se cargan todos en un desplegable (antes solo se veían los 50-100 primeros).
 * Escribe para buscar por nombre, email, teléfono o documento.
 */
export function CustomerSearchSelect({
  value,
  onChange,
  placeholder = 'Buscar inquilino…',
  clearLabel,
  className,
}: {
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  placeholder?: string;
  /** Texto de la opción «ninguno / todos»; sin él no se puede vaciar. */
  clearLabel?: string;
  className?: string;
}) {
  const selected = useCustomer(value);
  const [text, search, setText] = useDebouncedSearch();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const results = useQuery({
    queryKey: ['customers', 'picker', search] as const,
    queryFn: () =>
      apiFetch<PageDto<CustomerDto>>(
        `/customers/page?limit=20${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
    enabled: open,
    staleTime: 30_000,
  });

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const label = value ? (selected.data?.displayName ?? '…') : '';

  return (
    <div ref={boxRef} className={`relative ${className ?? ''}`}>
      <div className="relative">
        <Input
          value={open ? text : label}
          placeholder={value ? label : (clearLabel ?? placeholder)}
          onFocus={() => {
            setOpen(true);
            setText('');
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          className={value && clearLabel ? 'pr-8' : undefined}
        />
        {value && clearLabel && (
          <button
            type="button"
            aria-label={clearLabel}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full min-w-[240px] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {clearLabel && (
            <button
              type="button"
              className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
            >
              {clearLabel}
            </button>
          )}
          {results.isLoading ? (
            <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Buscando…
            </p>
          ) : (results.data?.items ?? []).length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Sin resultados</p>
          ) : (
            results.data!.items.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
                  c.id === value ? 'bg-accent' : ''
                }`}
                onClick={() => {
                  onChange(c.id);
                  setOpen(false);
                }}
              >
                <span className="block truncate">{c.displayName}</span>
                {c.email && (
                  <span className="block truncate text-xs text-muted-foreground">{c.email}</span>
                )}
              </button>
            ))
          )}
          {results.data?.nextCursor && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Escribe para afinar la búsqueda.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
