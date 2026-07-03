'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { Permission } from '@storageos/shared';
import type { ReactNode } from 'react';

import { useHasPermission } from '@/lib/auth/hooks';
import { cn } from '@/lib/utils';

interface NavTab {
  href: string;
  labelKey:
    | 'users'
    | 'roles'
    | 'profile'
    | 'security'
    | 'saasBilling'
    | 'billing'
    | 'verifactu'
    | 'widget'
    | 'branding'
    | 'faq'
    | 'integrations'
    | 'audit';
  /**
   * Permiso requerido para ver la pestaña. Sin él, sólo se muestra a quien lo
   * tiene (RBAC v2: el backend ya rechaza, esto evita pestañas muertas).
   */
  permission?: Permission;
}

const TABS: NavTab[] = [
  { href: '/settings/users', labelKey: 'users' },
  { href: '/settings/roles', labelKey: 'roles', permission: 'settings:manage' },
  { href: '/settings/profile', labelKey: 'profile' },
  { href: '/settings/security', labelKey: 'security', permission: 'settings:manage' },
  { href: '/settings/saas-billing', labelKey: 'saasBilling', permission: 'billing:configure' },
  { href: '/settings/billing', labelKey: 'billing', permission: 'billing:configure' },
  { href: '/settings/billing/verifactu', labelKey: 'verifactu', permission: 'invoices:manage' },
  { href: '/settings/widget', labelKey: 'widget' },
  { href: '/settings/branding', labelKey: 'branding', permission: 'settings:manage' },
  { href: '/settings/faq', labelKey: 'faq', permission: 'settings:manage' },
  { href: '/settings/integrations', labelKey: 'integrations', permission: 'integrations:manage' },
  { href: '/settings/audit', labelKey: 'audit', permission: 'settings:manage' },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('settings.nav');

  // Flags de permiso (hooks a nivel de componente; número fijo).
  const canManageSettings = useHasPermission('settings:manage');
  const canConfigureBilling = useHasPermission('billing:configure');
  const canManageInvoices = useHasPermission('invoices:manage');
  const canManageIntegrations = useHasPermission('integrations:manage');
  const allowed: Partial<Record<Permission, boolean>> = {
    'settings:manage': canManageSettings,
    'billing:configure': canConfigureBilling,
    'invoices:manage': canManageInvoices,
    'integrations:manage': canManageIntegrations,
  };
  const visibleTabs = TABS.filter((tab) => !tab.permission || (allowed[tab.permission] ?? false));

  return (
    <div className="flex flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
      <nav className="flex gap-1 border-b">
        {visibleTabs.map((tab) => {
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
