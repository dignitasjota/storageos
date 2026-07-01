'use client';

import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Bot,
  Boxes,
  Building2,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Gift,
  Inbox,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  Megaphone,
  MessageSquare,
  Package,
  PackagePlus,
  Replace,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  Sun,
  Ticket,
  TrendingUp,
  Users,
  Warehouse,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useFeatures, usePermissions } from '@/lib/auth/hooks';
import { useCustomerUnreadSummary } from '@/lib/customers/hooks';
import { useIncidentPendingCounts } from '@/lib/operations/hooks';
import { useSupportWaitingCount } from '@/lib/support/hooks';
import { useUnitChangePendingCount } from '@/lib/unit-changes/hooks';
import { useUnitRequestPendingCount } from '@/lib/unit-requests/hooks';

interface NavItem {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Si se define, solo quien tenga el permiso ve el item (RBAC v2). */
  permission?: Permission;
  /** Si se define, solo si el plan del tenant incluye esta feature. */
  feature?: TenantFeature;
  /** Sub-items desplegables; si está, el item agrupa y no navega él mismo. */
  children?: NavItem[];
}

interface NavGroup {
  /** Clave i18n de la cabecera del grupo (`sidebar.groups.*`). */
  labelKey: string;
  items: NavItem[];
}

/** Items principales, fuera de cualquier grupo (siempre los primeros). */
const PRIMARY_ITEMS: NavItem[] = [
  { href: '/today', labelKey: 'today', icon: Sun },
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
];

const GROUPS: NavGroup[] = [
  {
    labelKey: 'operations',
    items: [
      { href: '/customers', labelKey: 'customers', icon: Users, permission: 'customers:read' },
      {
        href: 'ops-contracting',
        labelKey: 'opsContracting',
        icon: FileText,
        children: [
          {
            href: '/contracts',
            labelKey: 'contracts',
            icon: FileText,
            permission: 'contracts:read',
          },
          {
            href: '/reservations',
            labelKey: 'reservations',
            icon: CalendarClock,
            permission: 'reservations:read',
          },
        ],
      },
      {
        href: 'unit-petitions',
        labelKey: 'unitPetitions',
        icon: Inbox,
        permission: 'contracts:read',
        children: [
          {
            href: '/unit-change-requests',
            labelKey: 'unitChangeRequests',
            icon: Replace,
            permission: 'contracts:read',
          },
          {
            href: '/unit-requests',
            labelKey: 'unitRequests',
            icon: PackagePlus,
            permission: 'contracts:read',
          },
        ],
      },
      {
        href: 'ops-daily',
        labelKey: 'opsDaily',
        icon: ClipboardList,
        children: [
          { href: '/calendar', labelKey: 'calendar', icon: CalendarDays, permission: 'tasks:read' },
          { href: '/tasks', labelKey: 'tasks', icon: ClipboardList, permission: 'tasks:read' },
          { href: '/maintenance', labelKey: 'maintenance', icon: Wrench, permission: 'tasks:read' },
          {
            href: '/incidents',
            labelKey: 'incidents',
            icon: AlertTriangle,
            permission: 'incidents:read',
          },
        ],
      },
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
        href: 'billing-bank',
        labelKey: 'billingBank',
        icon: Landmark,
        children: [
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
        ],
      },
      {
        href: 'billing-fiscal',
        labelKey: 'billingFiscal',
        icon: FileSpreadsheet,
        children: [
          {
            href: '/fiscal',
            labelKey: 'fiscal',
            icon: FileSpreadsheet,
            permission: 'invoices:manage',
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
        href: 'billing-portfolio',
        labelKey: 'billingPortfolio',
        icon: TrendingUp,
        children: [
          {
            href: '/rent-increases',
            labelKey: 'rentIncreases',
            icon: TrendingUp,
            permission: 'contracts:manage',
            feature: 'rent_increases',
          },
          {
            href: '/renewals',
            labelKey: 'renewals',
            icon: CalendarClock,
            permission: 'contracts:read',
          },
        ],
      },
    ],
  },
  {
    labelKey: 'crm',
    items: [
      {
        href: 'crm-acquisition',
        labelKey: 'crmAcquisition',
        icon: Sparkles,
        children: [
          { href: '/leads', labelKey: 'leads', icon: Sparkles, permission: 'leads:read' },
          {
            href: '/followups',
            labelKey: 'followups',
            icon: CalendarClock,
            permission: 'customers:read',
          },
        ],
      },
      {
        href: 'crm-messaging',
        labelKey: 'crmMessaging',
        icon: Mail,
        children: [
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
        ],
      },
      {
        href: 'crm-loyalty',
        labelKey: 'crmLoyalty',
        icon: Gift,
        children: [
          {
            href: '/promotions',
            labelKey: 'promotions',
            icon: Ticket,
            permission: 'promotions:read',
          },
          { href: '/referrals', labelKey: 'referrals', icon: Gift, permission: 'referrals:read' },
          { href: '/reviews', labelKey: 'reviews', icon: Star, permission: 'reviews:read' },
        ],
      },
    ],
  },
  {
    labelKey: 'analysis',
    items: [
      { href: '/analytics', labelKey: 'analytics', icon: BarChart3, permission: 'analytics:read' },
      { href: '/competitors', labelKey: 'competitors', icon: Store, permission: 'analytics:read' },
      { href: '/reports', labelKey: 'reports', icon: FileSpreadsheet, permission: 'reports:read' },
      {
        href: '/assistant',
        labelKey: 'assistant',
        icon: Bot,
        permission: 'ai:use',
        feature: 'ai_assistant',
      },
    ],
  },
];

const COLLAPSE_KEY = 'storageos:sidebar-collapsed';

export function AppSidebar() {
  const pathname = usePathname();
  const t = useTranslations('sidebar');
  const permissions = usePermissions();
  const features = useFeatures();
  const can = (p?: Permission) => !p || permissions.includes(p);
  const hasFeature = (f?: TenantFeature) => !f || features.includes(f);

  // Badge de cambios de trastero pendientes (solo si el usuario ve esa sección).
  const unitChangePending =
    useUnitChangePendingCount(permissions.includes('contracts:read')).data?.count ?? 0;
  const unitRequestPending =
    useUnitRequestPendingCount(permissions.includes('contracts:read')).data?.count ?? 0;
  // Incidencias abiertas por estado (reportadas + en investigación).
  const incidentCounts = useIncidentPendingCounts(permissions.includes('incidents:read')).data ?? {
    reported: 0,
    investigating: 0,
  };
  // Mensajes de inquilinos sin leer (total, para el item «Inquilinos»).
  const unreadMessages =
    useCustomerUnreadSummary(permissions.includes('customers:read')).data?.total ?? 0;
  // Tickets de soporte esperando respuesta del tenant (el admin ya contestó).
  const supportWaiting = useSupportWaitingCount().data?.count ?? 0;

  // Grupos colapsados (acordeón). Persistido en localStorage; arranca expandido
  // para no romper la hidratación (se sincroniza en cliente tras montar).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* localStorage no disponible */
    }
  }, []);
  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        /* noop */
      }
      return next;
    });
  }

  // Sub-menús desplegables (p. ej. «Peticiones de trastero»); expandidos por clic.
  const [openSubs, setOpenSubs] = useState<Set<string>>(new Set());
  function toggleSub(key: string) {
    setOpenSubs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Nº de pendientes por href (0 si el item no lleva badge). */
  function badgeCount(href: string): number {
    if (href === '/unit-change-requests') return unitChangePending;
    if (href === '/unit-requests') return unitRequestPending;
    if (href === '/customers') return unreadMessages;
    if (href === '/incidents') return incidentCounts.reported + incidentCounts.investigating;
    return 0;
  }

  /** Badge (JSX) por href, reutilizado en items normales y en sub-items. */
  function itemBadge(href: string) {
    if (href === '/unit-change-requests' && unitChangePending > 0) {
      return (
        <SidebarMenuBadge className="bg-primary text-primary-foreground">
          {unitChangePending}
        </SidebarMenuBadge>
      );
    }
    if (href === '/unit-requests' && unitRequestPending > 0) {
      return (
        <SidebarMenuBadge className="bg-primary text-primary-foreground">
          {unitRequestPending}
        </SidebarMenuBadge>
      );
    }
    if (href === '/customers' && unreadMessages > 0) {
      return (
        <SidebarMenuBadge className="bg-blue-500 text-white">{unreadMessages}</SidebarMenuBadge>
      );
    }
    if (
      href === '/incidents' &&
      (incidentCounts.reported > 0 || incidentCounts.investigating > 0)
    ) {
      return (
        // Dos contadores: rojo = reportadas (sin atender), ámbar = en investigación.
        <SidebarMenuBadge className="flex h-5 min-w-0 gap-1 px-0">
          {incidentCounts.reported > 0 && (
            <span
              title="Reportadas"
              className="flex h-5 min-w-5 items-center justify-center rounded-md bg-red-500 px-1 text-white"
            >
              {incidentCounts.reported}
            </span>
          )}
          {incidentCounts.investigating > 0 && (
            <span
              title="En investigación"
              className="flex h-5 min-w-5 items-center justify-center rounded-md bg-amber-500 px-1 text-white"
            >
              {incidentCounts.investigating}
            </span>
          )}
        </SidebarMenuBadge>
      );
    }
    return null;
  }

  function renderItem(item: NavItem) {
    const Icon = item.icon;

    // Item con sub-items desplegables (p. ej. «Peticiones de trastero»).
    if (item.children && item.children.length > 0) {
      const children = item.children.filter((c) => can(c.permission) && hasFeature(c.feature));
      if (children.length === 0) return null;
      const childActive = children.some(
        (c) => pathname === c.href || pathname.startsWith(`${c.href}/`),
      );
      const open = openSubs.has(item.href) || childActive;
      // Badge del padre = suma de los pendientes de sus hijos (solo peticiones de trastero).
      const parentTotal = children.reduce((sum, c) => sum + badgeCount(c.href), 0);
      return (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton
            onClick={() => toggleSub(item.href)}
            isActive={childActive}
            className="data-[active=true]:font-medium"
          >
            <Icon />
            <span>{t(item.labelKey)}</span>
            <ChevronDown className={`ml-auto transition-transform ${open ? '' : '-rotate-90'}`} />
          </SidebarMenuButton>
          {!open && parentTotal > 0 && (
            <SidebarMenuBadge className="bg-primary text-primary-foreground">
              {parentTotal}
            </SidebarMenuBadge>
          )}
          {open && (
            <SidebarMenuSub>
              {children.map((c) => {
                const cActive = pathname === c.href || pathname.startsWith(`${c.href}/`);
                const CIcon = c.icon;
                return (
                  <SidebarMenuSubItem key={c.href}>
                    <SidebarMenuSubButton asChild isActive={cActive}>
                      <Link href={c.href}>
                        <CIcon />
                        <span>{t(c.labelKey)}</span>
                      </Link>
                    </SidebarMenuSubButton>
                    {itemBadge(c.href)}
                  </SidebarMenuSubItem>
                );
              })}
            </SidebarMenuSub>
          )}
        </SidebarMenuItem>
      );
    }

    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <SidebarMenuItem key={item.href}>
        <SidebarMenuButton asChild isActive={active} className="data-[active=true]:font-medium">
          <Link href={item.href}>
            <Icon />
            <span>{t(item.labelKey)}</span>
          </Link>
        </SidebarMenuButton>
        {itemBadge(item.href)}
      </SidebarMenuItem>
    );
  }

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
        {/* Item principal suelto (sin cabecera de grupo), siempre el primero. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{PRIMARY_ITEMS.map((item) => renderItem(item))}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {GROUPS.map((group) => {
          const items = group.items.filter((item) =>
            // Un submenú solo cuenta si le queda algún hijo visible.
            item.children
              ? item.children.some((c) => can(c.permission) && hasFeature(c.feature))
              : can(item.permission) && hasFeature(item.feature),
          );
          if (items.length === 0) return null;
          const isCollapsed = collapsed.has(group.labelKey);
          return (
            <SidebarGroup key={group.labelKey}>
              <SidebarGroupLabel
                asChild
                className="cursor-pointer transition-colors hover:text-sidebar-foreground/80"
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(group.labelKey)}
                  aria-expanded={!isCollapsed}
                >
                  <span>{t(`groups.${group.labelKey}`)}</span>
                  <ChevronDown
                    className={`ml-auto transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                  />
                </button>
              </SidebarGroupLabel>
              <SidebarGroupContent hidden={isCollapsed}>
                <SidebarMenu>{items.map((item) => renderItem(item))}</SidebarMenu>
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
              isActive={pathname === '/support' || pathname.startsWith('/support/')}
              className="data-[active=true]:font-medium"
            >
              <Link href="/support">
                <LifeBuoy />
                <span>{t('support')}</span>
              </Link>
            </SidebarMenuButton>
            {supportWaiting > 0 && (
              <SidebarMenuBadge className="bg-blue-500 text-white">
                {supportWaiting}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
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
