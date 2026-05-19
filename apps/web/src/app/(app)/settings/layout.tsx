'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface NavTab {
  href: string;
  labelKey: 'users' | 'profile' | 'security' | 'billing';
}

const TABS: NavTab[] = [
  { href: '/settings/users', labelKey: 'users' },
  { href: '/settings/profile', labelKey: 'profile' },
  { href: '/settings/security', labelKey: 'security' },
  { href: '/settings/billing', labelKey: 'billing' },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('settings.nav');

  return (
    <div className="flex flex-col gap-6 px-6 py-6">
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
              {t(tab.labelKey)}
            </Link>
          );
        })}
      </nav>
      <div>{children}</div>
    </div>
  );
}
