'use client';

import { Building2, ChevronsUpDown, Plus } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityStore } from '@/lib/facilities/store';

/**
 * Selector de facility en el AppHeader. Persiste la selección en
 * `useFacilityStore` (Zustand + localStorage). Los listados que respetan
 * el filtro de facility leen `currentFacilityId` del store.
 *
 * Casos:
 *  - 0 facilities: muestra CTA "Crear local".
 *  - 1+ facilities: muestra la activa o "Todos los locales" si null.
 */
export function FacilitySwitcher() {
  const facilities = useFacilities();
  const { currentFacilityId, setCurrentFacility } = useFacilityStore();

  const list = facilities.data ?? [];
  const current = list.find((f) => f.id === currentFacilityId);

  if (facilities.isLoading) {
    return (
      <Button variant="outline" className="gap-2" disabled>
        <Building2 className="size-4" aria-hidden />
        <span className="text-sm">Cargando...</span>
      </Button>
    );
  }

  if (list.length === 0) {
    return (
      <Button variant="outline" className="gap-2" asChild>
        <Link href="/facilities">
          <Plus className="size-4" aria-hidden />
          <span className="text-sm">Crear primer local</span>
        </Link>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2" aria-haspopup="listbox">
          <Building2 className="size-4" aria-hidden />
          <span className="text-sm truncate max-w-[180px]">
            {current ? current.name : 'Todos los locales'}
          </span>
          <ChevronsUpDown className="ml-1 size-4 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" align="start">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Filtrar listados por local
        </DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => setCurrentFacility(null)}
          className={currentFacilityId === null ? 'bg-accent' : ''}
        >
          Todos los locales
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {list.map((f) => (
          <DropdownMenuItem
            key={f.id}
            onClick={() => setCurrentFacility(f.id)}
            className={f.id === currentFacilityId ? 'bg-accent' : ''}
          >
            <Building2 className="mr-2 size-4 opacity-60" aria-hidden />
            <span className="truncate">{f.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/facilities" className="cursor-pointer">
            <Plus className="mr-2 size-4 opacity-60" aria-hidden />
            Gestionar locales
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
