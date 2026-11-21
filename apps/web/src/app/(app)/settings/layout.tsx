'use client';

import { ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { activeSettingsHref, settingsItemFor } from './settings-nav';
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
import { useMe } from '@/lib/auth/hooks';
import { confirmLeaveIfDirty } from '@/lib/unsaved-changes';
import { cn } from '@/lib/utils';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const groups = useVisibleSettingsNav();
  const isHome = pathname === '/settings';
  const active = activeSettingsHref(pathname);
  const me = useMe();
  // Una página abierta por dirección directa sin el permiso de su entrada: no se
  // enseña el formulario (el servidor rechazaría guardar). Mientras carga el
  // usuario no se decide nada.
  const item = isHome ? null : settingsItemFor(pathname);
  const forbidden =
    !!item?.permission && !!me.data && !(me.data.permissions ?? []).includes(item.permission);
  // Hasta saber los permisos no se pinta una página que los pide: si no, lanza
  // sus peticiones (y el servidor responde 403) antes de que salga el aviso.
  const waiting = !!item?.permission && !me.data;

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6">
      {/* Móvil: desplegable agrupado. */}
      <div className="mb-4 md:hidden">
        <Select
          value={isHome ? '/settings' : (active ?? '')}
          onValueChange={(href) => {
            // Como los enlaces: si la página tiene cambios sin guardar, se pregunta.
            void confirmLeaveIfDirty().then((ok) => {
              if (ok) router.push(href);
            });
          }}
        >
          <SelectTrigger className="text-base">
            <SelectValue placeholder="Configuración" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="/settings">Inicio de Configuración</SelectItem>
            {groups.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel className="flex items-center gap-2 font-semibold text-foreground">
                  <g.icon className="size-4 text-primary" aria-hidden />
                  {g.label}
                </SelectLabel>
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
                <div className="flex items-center gap-2 px-3 pb-1.5 text-sm font-semibold text-foreground">
                  <g.icon className="size-4 text-primary" aria-hidden />
                  {g.label}
                </div>
                <ul className="ml-[1.2rem] space-y-0.5 border-l pl-2">
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
        <div className="min-w-0 flex-1">
          {waiting ? null : forbidden ? <NoPermission /> : children}
        </div>
      </div>
    </div>
  );
}

function NoPermission() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center">
      <ShieldOff className="size-6 text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">No tienes permiso para ver esta página</p>
        <p className="text-sm text-muted-foreground">
          Pide a quien gestiona tu cuenta que te dé acceso si lo necesitas.
        </p>
      </div>
      <Link href="/settings" className="text-sm font-medium text-primary hover:underline">
        Volver a Configuración
      </Link>
    </div>
  );
}
