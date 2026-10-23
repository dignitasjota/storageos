'use client';

import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  SearchCheck,
  CalendarCheck,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  UserRound,
  CalendarClock,
  Hourglass,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Gauge,
  Gift,
  HandCoins,
  KeyRound,
  Cctv,
  Landmark,
  Lightbulb,
  Undo2,
  Lock,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  Megaphone,
  Inbox,
  MessageCircle,
  MousePointerClick,
  Package,
  PackagePlus,
  Radio,
  Receipt,
  Replace,
  Settings,
  Share2,
  Sparkles,
  Star,
  Store,
  Sun,
  Target,
  Ticket,
  TicketPercent,
  TrendingUp,
  Users,
  Wallet,
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
import { useFeatures, usePanelBrand, usePermissions } from '@/lib/auth/hooks';
import { useCustomerUnreadSummary } from '@/lib/customers/hooks';
import { useIncidentPendingCounts } from '@/lib/operations/hooks';
import { appInitials, appName, brandColorOf, textColorOn } from '@/lib/portal/tenant-app';
import { useProductUpdatesUnread } from '@/lib/product-updates/hooks';
import { useSupportWaitingCount } from '@/lib/support/hooks';
import { useUnitChangePendingCount } from '@/lib/unit-changes/hooks';
import { useUnitRequestPendingCount } from '@/lib/unit-requests/hooks';
import { useWhatsappUnreadCount } from '@/lib/whatsapp/hooks';

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

/** Items principales, fijos en la cabecera del menú (no se desplazan). */
const PRIMARY_ITEMS: NavItem[] = [
  { href: '/today', labelKey: 'today', icon: Sun },
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
];

const GROUPS: NavGroup[] = [
  {
    labelKey: 'operations',
    items: [
      { href: '/customers', labelKey: 'customers', icon: Users, permission: 'customers:read' },
      { href: '/messages', labelKey: 'messages', icon: Inbox, permission: 'customers:read' },
      {
        href: 'ops-contracting',
        labelKey: 'contracts',
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
          {
            href: '/waitlist',
            labelKey: 'waitlist',
            icon: Hourglass,
            permission: 'reservations:read',
          },
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
        href: 'ops-access',
        labelKey: 'access',
        icon: KeyRound,
        children: [
          {
            href: '/access',
            labelKey: 'access',
            icon: KeyRound,
            permission: 'access:read',
            feature: 'access_control',
          },
          {
            href: '/cameras',
            labelKey: 'cameras',
            icon: Cctv,
            permission: 'access:read',
            feature: 'cameras',
          },
        ],
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
        href: '/owners',
        labelKey: 'owners',
        icon: UserRound,
        permission: 'facilities:read',
        feature: 'multi_owner',
      },
    ],
  },
  {
    labelKey: 'billing',
    items: [
      { href: '/invoices', labelKey: 'invoices', icon: CreditCard, permission: 'invoices:read' },
      {
        href: 'billing-collections',
        labelKey: 'billingCollections',
        icon: HandCoins,
        children: [
          {
            href: '/collections-month',
            labelKey: 'collectionsMonth',
            icon: CalendarCheck,
            permission: 'payments:read',
          },
          { href: '/arrears', labelKey: 'arrears', icon: HandCoins, permission: 'payments:read' },
          { href: '/cash', labelKey: 'cash', icon: Wallet, permission: 'payments:read' },
          {
            href: '/collections',
            labelKey: 'collections',
            icon: Lock,
            permission: 'collections:read',
            feature: 'collections',
          },
          {
            href: '/returned-receipts',
            labelKey: 'returnedReceipts',
            icon: Undo2,
            permission: 'payments:read',
          },
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
      { href: '/expenses', labelKey: 'expenses', icon: Receipt, permission: 'expenses:read' },
      {
        href: '/fiscal',
        labelKey: 'fiscal',
        icon: FileSpreadsheet,
        permission: 'invoices:manage',
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
          {
            href: '/opportunities',
            labelKey: 'opportunities',
            icon: Lightbulb,
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
            href: '/whatsapp',
            labelKey: 'whatsapp',
            icon: MessageCircle,
            permission: 'communications:read',
            feature: 'whatsapp_business',
          },
          {
            href: '/communications',
            labelKey: 'communications',
            icon: Mail,
            permission: 'communications:read',
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
          {
            href: '/coupons',
            labelKey: 'coupons',
            icon: TicketPercent,
            permission: 'promotions:read',
          },
          { href: '/referrals', labelKey: 'referrals', icon: Gift, permission: 'referrals:read' },
          { href: '/reviews', labelKey: 'reviews', icon: Star, permission: 'reviews:read' },
        ],
      },
      {
        href: 'crm-marketing',
        labelKey: 'crmMarketing',
        icon: Target,
        children: [
          {
            href: '/marketing/summary',
            labelKey: 'marketingSummary',
            icon: Gauge,
            permission: 'marketing:read',
          },
          {
            href: '/marketing/channels',
            labelKey: 'marketingChannels',
            icon: Radio,
            permission: 'marketing:read',
          },
          {
            href: '/marketing/performance',
            labelKey: 'marketingPerformance',
            icon: TrendingUp,
            permission: 'marketing:read',
          },
          {
            href: '/marketing/web',
            labelKey: 'marketingWeb',
            icon: MousePointerClick,
            permission: 'marketing:read',
          },
          {
            href: '/marketing/social',
            labelKey: 'marketingSocial',
            icon: Share2,
            permission: 'marketing:read',
          },
        ],
      },
    ],
  },
  {
    labelKey: 'analysis',
    items: [
      { href: '/analytics', labelKey: 'analytics', icon: BarChart3, permission: 'analytics:read' },
      {
        href: 'analysis-market',
        labelKey: 'analysisMarket',
        icon: Store,
        children: [
          {
            href: '/competitors',
            labelKey: 'competitors',
            icon: Store,
            permission: 'analytics:read',
          },
          {
            href: '/seo',
            labelKey: 'seo',
            icon: SearchCheck,
            permission: 'analytics:read',
            feature: 'local_seo',
          },
        ],
      },
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
  const panelBrand = usePanelBrand();
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
  const updatesUnread = useProductUpdatesUnread().data?.count ?? 0;
  // Mensajes de WhatsApp sin leer (extra «WhatsApp Business»).
  const whatsappUnread =
    useWhatsappUnreadCount(
      permissions.includes('communications:read') && features.includes('whatsapp_business'),
    ).data?.count ?? 0;

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
    if (href === '/messages') return unreadMessages;
    if (href === '/whatsapp') return whatsappUnread;
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
    if (href === '/whatsapp' && whatsappUnread > 0) {
      return (
        <SidebarMenuBadge className="bg-emerald-600 text-white">{whatsappUnread}</SidebarMenuBadge>
      );
    }
    if (href === '/messages' && unreadMessages > 0) {
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
      // Con un solo hijo visible (p. ej. Accesos sin cámaras) no hace falta desplegable.
      if (children.length === 1) return renderItem(children[0]!);
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
          className="flex h-14 min-w-0 items-center gap-2 px-2 transition-opacity hover:opacity-80"
        >
          {panelBrand ? (
            <PanelBrandMark brand={panelBrand} />
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/icon.svg"
                alt="TrasterOS"
                className="size-8 shrink-0 rounded-lg shadow-sm"
              />
              <span className="text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                TrasterOS
              </span>
            </>
          )}
        </Link>
        {/* Hoy y Resumen, fijos arriba: no se desplazan con el resto del menú. */}
        <SidebarMenu>{PRIMARY_ITEMS.map((item) => renderItem(item))}</SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="scrollbar-subtle gap-0 border-y border-sidebar-border">
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
              isActive={pathname === '/updates'}
              className="data-[active=true]:font-medium"
            >
              <Link href="/updates">
                <Sparkles />
                <span>{t('updates')}</span>
              </Link>
            </SidebarMenuButton>
            {updatesUnread > 0 && (
              <SidebarMenuBadge className="bg-primary text-primary-foreground">
                {updatesUnread}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === '/help'}
              className="data-[active=true]:font-medium"
            >
              <Link href="/help">
                <BookOpen />
                <span>{t('help')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
              <Link href="/settings">
                <Settings />
                <span>{t('settings')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {panelBrand && (
          <p className="px-2 pb-1 text-[11px] text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden">
            con TrasterOS
          </p>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Cabecera del menú con la marca del tenant («Panel con tu marca», plan Pro):
 * su logo (o, sin logo, sus iniciales sobre su color) y su nombre al lado.
 * Con el menú plegado solo queda el logo.
 */
function PanelBrandMark({ brand }: { brand: NonNullable<ReturnType<typeof usePanelBrand>> }) {
  const color = brandColorOf(brand);
  return (
    <>
      {brand.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brand.logoUrl}
          alt=""
          className="h-8 w-auto max-w-[88px] shrink-0 object-contain object-left group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:max-w-8"
        />
      ) : (
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold shadow-sm"
          style={{ backgroundColor: color, color: textColorOn(color) }}
        >
          {appInitials(brand.name)}
        </span>
      )}
      <span
        className="min-w-0 truncate text-base font-semibold leading-tight tracking-tight group-data-[collapsible=icon]:hidden"
        title={brand.name}
      >
        {appName(brand.name)}
      </span>
    </>
  );
}
