'use client';

import { Building2, ChevronsUpDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Placeholder de seleccion de facility. En Fase 2, cuando existan
 * `facilities` reales, listara las del tenant actual.
 */
export function FacilitySwitcher() {
  const t = useTranslations('appHeader.facilitySwitcher');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2" aria-haspopup="listbox">
          <Building2 className="size-4" aria-hidden />
          <span className="text-sm">{t('placeholder')}</span>
          <ChevronsUpDown className="ml-1 size-4 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" align="start">
        <DropdownMenuItem disabled className="text-xs text-muted-foreground">
          {t('hint')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
