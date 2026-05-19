'use client';

import {
  Boxes,
  Building2,
  CalendarClock,
  CreditCard,
  FileText,
  LayoutDashboard,
  Settings,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

interface NavItem {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  enabled: boolean;
}

const NAV: NavItem[] = [
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard, enabled: true },
  { href: '/facilities', labelKey: 'facilities', icon: Building2, enabled: true },
  { href: '/units', labelKey: 'units', icon: Boxes, enabled: true },
  { href: '/customers', labelKey: 'customers', icon: Users, enabled: true },
  { href: '/contracts', labelKey: 'contracts', icon: FileText, enabled: true },
  { href: '/reservations', labelKey: 'reservations', icon: CalendarClock, enabled: true },
  { href: '/invoices', labelKey: 'invoices', icon: CreditCard, enabled: true },
];

export function AppSidebar() {
  const pathname = usePathname();
  const t = useTranslations('sidebar');
  const common = useTranslations('common');

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-14 items-center px-2 text-base font-semibold tracking-tight">
          StorageOS
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.enabled ? undefined : common('comingSoon')}
                      disabled={!item.enabled}
                    >
                      {item.enabled ? (
                        <Link href={item.href}>
                          <Icon />
                          <span>{t(item.labelKey)}</span>
                        </Link>
                      ) : (
                        <span aria-disabled="true" className="cursor-not-allowed opacity-60">
                          <Icon />
                          <span>{t(item.labelKey)}</span>
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/settings' || pathname.startsWith('/settings/')}
            >
              <Link href="/settings/users">
                <Settings />
                <span>{t('settings')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
