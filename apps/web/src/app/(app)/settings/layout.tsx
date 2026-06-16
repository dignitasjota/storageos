'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface NavTab {
  href: string;
  labelKey: 'users' | 'profile' | 'security' | 'billing' | 'verifactu' | 'widget' | 'integrations';
}

const TABS: NavTab[] = [
  { href: '/settings/users', labelKey: 'users' },
  { href: '/settings/profile', labelKey: 'profile' },
  { href: '/settings/security', labelKey: 'security' },
  { href: '/settings/billing', labelKey: 'billing' },
  { href: '/settings/billing/verifactu', labelKey: 'verifactu' },
  { href: '/settings/widget', labelKey: 'widget' },
  { href: '/settings/integrations', labelKey: 'integrations' },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('settings.nav');

  return (
    <div className="flex flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
      <nav className="flex gap-1 border-b">
        {TABS.map((tab) => {
          // Para evitar que /settings/billing se marque activo cuando el path
          // es /settings/billing/verifactu, comparamos coincidencia exacta o
          // un sub-segmento. La tab más específica gana porque su href es
          // prefijo más largo.
          const isExact = pathname === tab.href;
          const isPrefix = pathname.startsWith(`${tab.href}/`);
          // El tab gana si es exacto o si su href es prefijo y NO hay otro
          // tab con un href más largo que también sea prefijo.
          const hasMoreSpecific = TABS.some(
            (other) =>
              other.href !== tab.href &&
              other.href.startsWith(`${tab.href}/`) &&
              (pathname === other.href || pathname.startsWith(`${other.href}/`)),
          );
          const active = isExact || (isPrefix && !hasMoreSpecific);
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
              {t(tab.labelKey)}
            </Link>
          );
        })}
      </nav>
      <div>{children}</div>
    </div>
  );
}
