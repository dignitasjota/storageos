'use client';

import {
  AlertTriangle,
  BarChart3,
  Bot,
  Boxes,
  Building2,
  CalendarClock,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  Gift,
  FileText,
  KeyRound,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Package,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Ticket,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { Permission } from '@storageos/shared';

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
import { useHasPermission } from '@/lib/auth/hooks';

interface NavItem {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  enabled: boolean;
  /** Si se define, sólo quien tenga el permiso verá el item (RBAC v2). */
  permission?: Permission;
}

const NAV: NavItem[] = [
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard, enabled: true },
  { href: '/facilities', labelKey: 'facilities', icon: Building2, enabled: true },
  { href: '/units', labelKey: 'units', icon: Boxes, enabled: true },
  { href: '/customers', labelKey: 'customers', icon: Users, enabled: true },
  { href: '/contracts', labelKey: 'contracts', icon: FileText, enabled: true },
  { href: '/reservations', labelKey: 'reservations', icon: CalendarClock, enabled: true },
  { href: '/invoices', labelKey: 'invoices', icon: CreditCard, enabled: true },
  {
    href: '/settings/billing/verifactu',
    labelKey: 'verifactu',
    icon: ShieldCheck,
    enabled: true,
    permission: 'invoices:manage',
  },
  { href: '/leads', labelKey: 'leads', icon: Sparkles, enabled: true },
  { href: '/communications', labelKey: 'communications', icon: Mail, enabled: true },
  { href: '/message-templates', labelKey: 'messageTemplates', icon: MessageSquare, enabled: true },
  { href: '/automations', labelKey: 'automations', icon: Bot, enabled: true },
  { href: '/tasks', labelKey: 'tasks', icon: ClipboardList, enabled: true },
  { href: '/incidents', labelKey: 'incidents', icon: AlertTriangle, enabled: true },
  { href: '/access', labelKey: 'access', icon: KeyRound, enabled: true },
  { href: '/products', labelKey: 'products', icon: Package, enabled: true },
  { href: '/promotions', labelKey: 'promotions', icon: Ticket, enabled: true },
  { href: '/referrals', labelKey: 'referrals', icon: Gift, enabled: true },
  { href: '/analytics', labelKey: 'analytics', icon: BarChart3, enabled: true },
  { href: '/reports', labelKey: 'reports', icon: FileSpreadsheet, enabled: true },
  { href: '/reviews', labelKey: 'reviews', icon: Star, enabled: true },
];

export function AppSidebar() {
  const pathname = usePathname();
  const t = useTranslations('sidebar');
  const common = useTranslations('common');
  // RBAC v2: el único item gateado es Veri*Factu (invoices:manage = owner+manager).
  const canManageInvoices = useHasPermission('invoices:manage');

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
              {NAV.filter(
                (item) =>
                  !item.permission || (item.permission === 'invoices:manage' && canManageInvoices),
              ).map((item) => {
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
