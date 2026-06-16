'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface NavTab {
  href: string;
  label: string;
}

const TABS: NavTab[] = [
  { href: '/access/credentials', label: 'Credenciales' },
  { href: '/access/devices', label: 'Dispositivos' },
  { href: '/access/logs', label: 'Registro' },
];

export default function AccessLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Control de accesos</h1>
        <p className="text-sm text-muted-foreground">
          Gestiona credenciales (PIN, QR, RFID), dispositivos físicos y el registro de entradas y
          salidas de inquilinos.
        </p>
      </div>
      <nav className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'border-b-2 px-3 py-2 text-sm transition-colors',
                active
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div>{children}</div>
    </div>
  );
}
