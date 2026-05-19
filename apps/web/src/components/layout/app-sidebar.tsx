'use client';

import { Building2, CreditCard, LayoutDashboard, Settings, Users } from 'lucide-react';
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
  { href: '/facilities', labelKey: 'facilities', icon: Building2, enabled: false },
  { href: '/customers', labelKey: 'customers', icon: Users, enabled: false },
  { href: '/billing', labelKey: 'billing', icon: CreditCard, enabled: false },
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
              tooltip={common('comingSoon')}
              disabled
              className="cursor-not-allowed opacity-60"
            >
              <Settings />
              <span>{t('settings')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
