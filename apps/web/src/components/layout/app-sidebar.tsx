'use client';

import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Bot,
  Boxes,
  Building2,
  CalendarClock,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Gift,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Mail,
  Megaphone,
  MessageSquare,
  Package,
  Replace,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Ticket,
  TrendingUp,
  Users,
  Warehouse,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { Permission, TenantFeature } from '@storageos/shared';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useFeatures, usePermissions } from '@/lib/auth/hooks';

interface NavItem {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Si se define, solo quien tenga el permiso ve el item (RBAC v2). */
  permission?: Permission;
  /** Si se define, solo si el plan del tenant incluye esta feature. */
  feature?: TenantFeature;
}

interface NavGroup {
  /** Clave i18n de la cabecera del grupo (`sidebar.groups.*`). */
  labelKey: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    labelKey: 'principal',
    items: [
      { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
      {
        href: '/assistant',
        labelKey: 'assistant',
        icon: Bot,
        permission: 'ai:use',
        feature: 'ai_assistant',
      },
    ],
  },
  {
    labelKey: 'operations',
    items: [
      { href: '/customers', labelKey: 'customers', icon: Users, permission: 'customers:read' },
      { href: '/contracts', labelKey: 'contracts', icon: FileText, permission: 'contracts:read' },
      {
        href: '/reservations',
        labelKey: 'reservations',
        icon: CalendarClock,
        permission: 'reservations:read',
      },
      {
        href: '/unit-change-requests',
        labelKey: 'unitChangeRequests',
        icon: Replace,
        permission: 'contracts:read',
      },
      { href: '/tasks', labelKey: 'tasks', icon: ClipboardList, permission: 'tasks:read' },
      {
        href: '/incidents',
        labelKey: 'incidents',
        icon: AlertTriangle,
        permission: 'incidents:read',
      },
    ],
  },
  {
    labelKey: 'inventory',
    items: [
      {
        href: '/facilities',
        labelKey: 'facilities',
        icon: Building2,
        permission: 'facilities:read',
      },
      { href: '/units', labelKey: 'units', icon: Boxes, permission: 'units:read' },
      { href: '/products', labelKey: 'products', icon: Package, permission: 'products:read' },
      {
        href: '/insurance-plans',
        labelKey: 'insurance',
        icon: Shield,
        permission: 'insurance:read',
        feature: 'insurance',
      },
    ],
  },
  {
    labelKey: 'billing',
    items: [
      { href: '/invoices', labelKey: 'invoices', icon: CreditCard, permission: 'invoices:read' },
      {
        href: '/sepa-remittances',
        labelKey: 'sepaRemittances',
        icon: Landmark,
        permission: 'payments:read',
        feature: 'sepa',
      },
      {
        href: '/bank-reconciliation',
        labelKey: 'bankReconciliation',
        icon: ArrowLeftRight,
        permission: 'payments:read',
        feature: 'bank_reconciliation',
      },
      {
        href: '/rent-increases',
        labelKey: 'rentIncreases',
        icon: TrendingUp,
        permission: 'contracts:manage',
        feature: 'rent_increases',
      },
      {
        href: '/settings/billing/verifactu',
        labelKey: 'verifactu',
        icon: ShieldCheck,
        permission: 'invoices:manage',
      },
    ],
  },
  {
    labelKey: 'access',
    items: [
      {
        href: '/access',
        labelKey: 'access',
        icon: KeyRound,
        permission: 'access:read',
        feature: 'access_control',
      },
    ],
  },
  {
    labelKey: 'crm',
    items: [
      { href: '/leads', labelKey: 'leads', icon: Sparkles, permission: 'leads:read' },
      {
        href: '/campaigns',
        labelKey: 'campaigns',
        icon: Megaphone,
        permission: 'communications:read',
      },
      {
        href: '/communications',
        labelKey: 'communications',
        icon: Mail,
        permission: 'communications:read',
      },
      {
        href: '/message-templates',
        labelKey: 'messageTemplates',
        icon: MessageSquare,
        permission: 'templates:read',
      },
      {
        href: '/automations',
        labelKey: 'automations',
        icon: Bot,
        permission: 'automations:read',
        feature: 'automations',
      },
      { href: '/promotions', labelKey: 'promotions', icon: Ticket, permission: 'promotions:read' },
      { href: '/referrals', labelKey: 'referrals', icon: Gift, permission: 'referrals:read' },
      { href: '/reviews', labelKey: 'reviews', icon: Star, permission: 'reviews:read' },
    ],
  },
  {
    labelKey: 'analysis',
    items: [
      { href: '/analytics', labelKey: 'analytics', icon: BarChart3, permission: 'analytics:read' },
      { href: '/reports', labelKey: 'reports', icon: FileSpreadsheet, permission: 'reports:read' },
    ],
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const t = useTranslations('sidebar');
  const permissions = usePermissions();
  const features = useFeatures();
  const can = (p?: Permission) => !p || permissions.includes(p);
  const hasFeature = (f?: TenantFeature) => !f || features.includes(f);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          href="/dashboard"
          className="flex h-14 items-center gap-2 px-2 transition-opacity hover:opacity-80"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Warehouse className="size-4" />
          </span>
          <span className="text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            StorageOS
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {GROUPS.map((group) => {
          const items = group.items.filter(
            (item) => can(item.permission) && hasFeature(item.feature),
          );
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.labelKey}>
              <SidebarGroupLabel>{t(`groups.${group.labelKey}`)}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => {
                    const Icon = item.icon;
                    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          className="data-[active=true]:font-medium"
                        >
                          <Link href={item.href}>
                            <Icon />
                            <span>{t(item.labelKey)}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/settings' || pathname.startsWith('/settings/')}
              className="data-[active=true]:font-medium"
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
