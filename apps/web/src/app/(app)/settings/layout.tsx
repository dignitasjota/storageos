'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { activeSettingsHref } from './settings-nav';
import { useVisibleSettingsNav } from './use-settings-nav';

import type { ReactNode } from 'react';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const groups = useVisibleSettingsNav();
  const isHome = pathname === '/settings';
  const active = activeSettingsHref(pathname);

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6">
      {/* Móvil: desplegable agrupado. */}
      <div className="mb-4 md:hidden">
        <Select
          value={isHome ? '/settings' : (active ?? '')}
          onValueChange={(href) => router.push(href)}
        >
          <SelectTrigger className="text-base">
            <SelectValue placeholder="Configuración" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="/settings">Inicio de Configuración</SelectItem>
            {groups.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.items.map((i) => (
                  <SelectItem key={i.href} value={i.href}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex gap-8">
        {/* Escritorio: menú lateral agrupado. */}
        <nav className="hidden w-52 shrink-0 md:block" aria-label="Configuración">
          <Link
            href="/settings"
            className={cn(
              'mb-3 block rounded-md px-3 py-1.5 text-sm',
              isHome
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            Inicio
          </Link>
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {g.label}
                </div>
                <ul className="space-y-0.5">
                  {g.items.map((i) => (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        className={cn(
                          'block rounded-md px-3 py-1.5 text-sm',
                          active === i.href && !isHome
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                        )}
                      >
                        {i.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
