'use client';

import {
  Calculator,
  Activity,
  AlertTriangle,
  BarChart3,
  BellRing,
  ChevronDown,
  Building2,
  Eye,
  FileText,
  FileWarning,
  CalendarCheck,
  CalendarClock,
  Globe,
  HardDrive,
  Gauge,
  HeartPulse,
  Hourglass,
  Inbox,
  CreditCard,
  Landmark,
  Layers,
  LifeBuoy,
  Mail,
  LogOut,
  Megaphone,
  Menu,
  Package,
  PackagePlus,
  ScrollText,
  Sparkles,
  UserCog,
  ShieldCheck,
  Ticket,
  Trash2,
  TrendingUp,
  Wallet,
  MessageCircle,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeProvider } from 'next-themes';
import { useEffect, useState, type ReactNode } from 'react';

import type { SuperAdminDto, SuperAdminRefreshResponse } from '@storageos/shared';

import { AdminCommandPalette } from '@/components/admin/admin-command-palette';
import { ConfirmProvider } from '@/components/confirm-provider';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { InstallPwaButton } from '@/components/pwa/install-pwa-button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { adminApiFetch } from '@/lib/admin/api';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import {
  useAdminLogout,
  useAdminNotifUnreadCount,
  useAdminOpenTicketsCount,
  useAdminToday,
} from '@/lib/admin/hooks';
import { SUPERADMIN_ONLY_PATHS, useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';

interface AdminNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface AdminNavGroup {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: AdminNavItem[];
}

type AdminNavEntry = AdminNavItem | AdminNavGroup;

function isGroup(e: AdminNavEntry): e is AdminNavGroup {
  return 'children' in e;
}

// Menú agrupado: los items afines cuelgan de un grupo desplegable; «Soporte»
// queda suelto (lleva badge). La página de 2FA del super admin (/admin/security)
// vive en el menú de usuario, no aquí.
const ADMIN_NAV: AdminNavEntry[] = [
  { href: '/admin/today', label: 'Hoy', icon: CalendarCheck },
  {
    label: 'Negocio',
    icon: BarChart3,
    children: [
      { href: '/admin/metrics', label: 'Métricas', icon: BarChart3 },
      { href: '/admin/finance', label: 'Finanzas', icon: Wallet },
      { href: '/admin/health', label: 'Salud', icon: HeartPulse },
      { href: '/admin/adoption', label: 'Adopción', icon: TrendingUp },
      { href: '/admin/opportunities', label: 'Oportunidades', icon: Sparkles },
      { href: '/admin/at-risk', label: 'En riesgo', icon: AlertTriangle },
      { href: '/admin/trials', label: 'Trials', icon: Hourglass },
    ],
  },
  {
    label: 'Tenants',
    icon: Building2,
    children: [
      { href: '/admin/tenants', label: 'Tenants', icon: Building2 },
      { href: '/admin/followups', label: 'Seguimientos', icon: CalendarClock },
      { href: '/admin/custom-domains', label: 'Dominios propios', icon: Globe },
      { href: '/admin/billing-health', label: 'Facturación de los tenants', icon: FileWarning },
      { href: '/admin/usage', label: 'Uso por tenant', icon: HardDrive },
    ],
  },
  {
    label: 'Facturación',
    icon: Package,
    children: [
      { href: '/admin/receivables', label: 'Cobros pendientes', icon: AlertTriangle },
      { href: '/admin/billing-calendar', label: 'Calendario de cobros', icon: CalendarClock },
      { href: '/admin/quote', label: 'Simulador de cuota', icon: Calculator },
      { href: '/admin/plans', label: 'Planes', icon: Package },
      { href: '/admin/addons', label: 'Add-ons', icon: PackagePlus },
      { href: '/admin/platform-billing', label: 'Facturación SaaS', icon: FileText },
      { href: '/admin/platform-dunning', label: 'Dunning SaaS', icon: BellRing },
      { href: '/admin/platform-sepa', label: 'SEPA (BBVA)', icon: Landmark },
      { href: '/admin/platform-sepa/remittances', label: 'Remesas SEPA', icon: Landmark },
      { href: '/admin/coupons', label: 'Cupones', icon: Ticket },
      { href: '/admin/payments', label: 'Cobros de los tenants', icon: CreditCard },
    ],
  },
  {
    label: 'Comunicación',
    icon: Megaphone,
    children: [
      { href: '/admin/announcements', label: 'Anuncios', icon: Megaphone },
      { href: '/admin/product-updates', label: 'Novedades', icon: Sparkles },
      { href: '/admin/platform-banner', label: 'Banner y avisos', icon: BellRing },
      { href: '/admin/website', label: 'Web de TrasterOS', icon: Globe },
      { href: '/admin/platform-alerts', label: 'Alertas', icon: BellRing },
      { href: '/admin/email', label: 'Correo saliente', icon: Mail },
      { href: '/admin/whatsapp-ai', label: 'IA de WhatsApp', icon: MessageCircle },
      { href: '/admin/email-log', label: 'Correos enviados', icon: Inbox },
      { href: '/admin/legal', label: 'Páginas legales', icon: FileText },
    ],
  },
  { href: '/admin/support', label: 'Soporte', icon: LifeBuoy },
  {
    label: 'Seguridad',
    icon: ShieldCheck,
    children: [
      { href: '/admin/security-dashboard', label: 'Dashboard seguridad', icon: Gauge },
      { href: '/admin/security-events', label: 'Eventos de seguridad', icon: Activity },
      { href: '/admin/audit-logs', label: 'Audit logs', icon: ScrollText },
      { href: '/admin/impersonation', label: 'Impersonaciones', icon: Eye },
      { href: '/admin/super-admins', label: 'Super admins', icon: UserCog },
    ],
  },
  {
    label: 'Sistema',
    icon: Layers,
    children: [
      { href: '/admin/queues', label: 'Sistema y colas', icon: Layers },
      { href: '/admin/webhooks-cleanup', label: 'Cleanup webhooks', icon: Trash2 },
    ],
  },
];

/**
 * Layout del panel super admin.
 *
 * Bootstrap: al montar, intentamos `/admin/auth/refresh` para recuperar
 * el access token desde la cookie httpOnly. Si funciona, cargamos `me`;
 * si no, redirigimos a `/admin/login`.
 *
 * La pagina `/admin/login` reusa este layout pero se renderiza sin chrome
 * (chequea pathname) y no dispara el guard.
 */
export function AdminLayoutClient({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // El panel admin tiene su propio tema (oscuro por defecto), independiente del
  // panel normal, con su propia clave de almacenamiento. Son grupos de rutas
  // hermanos que no coexisten, así que no hay conflicto de temas.
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      storageKey="storageos-admin-theme"
    >
      <ConfirmProvider>
        {pathname === '/admin/login' ? (
          <div className="min-h-screen bg-background">{children}</div>
        ) : (
          <AdminGuard>
            <AdminShell>{children}</AdminShell>
          </AdminGuard>
        )}
      </ConfirmProvider>
    </ThemeProvider>
  );
}

function AdminGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const token = useAdminAuthStore((s) => s.superAdminToken);
  const setSession = useAdminAuthStore((s) => s.setSession);
  const setAccessToken = useAdminAuthStore((s) => s.setAccessToken);
  const setAdmin = useAdminAuthStore((s) => s.setAdmin);
  const setBootstrapping = useAdminAuthStore((s) => s.setBootstrapping);
  const clear = useAdminAuthStore((s) => s.clear);
  const isBootstrapping = useAdminAuthStore((s) => s.isBootstrapping);
  // Fallo que no es «sesión caducada» (API caída, red): sin esto el panel se
  // quedaba en «Cargando panel…» para siempre.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBootstrapping(true);

    (async () => {
      try {
        // 1) Si no hay access token en memoria intentamos refresh via cookie.
        if (!useAdminAuthStore.getState().superAdminToken) {
          const res = await fetch(`${env.apiUrl}/v1/admin/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
          });
          if (cancelled) return;
          // Sin sesión (401/403) → login; un 5xx (API caída) no es motivo
          // para echar al admin: se ofrece reintentar.
          if (res.status >= 500) {
            setFailed(true);
            return;
          }
          if (!res.ok) {
            clear();
            router.replace('/admin/login');
            return;
          }
          const data = (await res.json()) as SuperAdminRefreshResponse;
          setAccessToken(data.accessToken);
        }

        // 2) Con access token valido, cargamos /me.
        const me = await adminApiFetch<SuperAdminDto>('/admin/auth/me');
        if (cancelled) return;
        const currentToken = useAdminAuthStore.getState().superAdminToken;
        if (currentToken) {
          setSession(currentToken, me);
        } else {
          setAdmin(me);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 401) {
          clear();
          router.replace('/admin/login');
          return;
        }
        // Otros errores: aviso con «Reintentar».
        setFailed(true);
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed && !token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center text-sm">
        <p className="text-muted-foreground">
          No hemos podido conectar con el servidor. Comprueba la conexión y vuelve a intentarlo.
        </p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reintentar
        </Button>
      </div>
    );
  }

  if (isBootstrapping || !token) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Cargando panel...
      </div>
    );
  }

  return <>{children}</>;
}

/** Un enlace de hoja del nav (con badge opcional de tickets en «Soporte»). */
function AdminNavLink({
  item,
  pathname,
  openTickets,
  urgentToday,
  onNavigate,
  nested,
}: {
  item: AdminNavItem;
  pathname: string;
  openTickets: number;
  urgentToday: number;
  onNavigate?: () => void;
  nested?: boolean;
}) {
  const Icon = item.icon;
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2 rounded-md py-2 text-sm transition-colors',
        nested ? 'pl-9 pr-3' : 'px-3',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      {item.label}
      {item.href === '/admin/support' && openTickets > 0 && (
        <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1 text-xs font-medium text-white">
          {openTickets}
        </span>
      )}
      {item.href === '/admin/today' && urgentToday > 0 && (
        <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-medium text-white">
          {urgentToday}
        </span>
      )}
    </Link>
  );
}

/** Lista de enlaces del nav admin (reutilizada en el aside desktop y el drawer móvil). */
function AdminNavLinks({
  pathname,
  openTickets,
  urgentToday,
  onNavigate,
}: {
  pathname: string;
  openTickets: number;
  urgentToday: number;
  onNavigate?: () => void;
}) {
  // Grupos abiertos manualmente por el usuario. Un grupo también se muestra
  // abierto si contiene la ruta activa (para que al navegar quede desplegado).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="flex-1 space-y-1 px-2 py-3">
      {ADMIN_NAV.map((entry) => {
        if (!isGroup(entry)) {
          return (
            <AdminNavLink
              key={entry.href}
              item={entry}
              pathname={pathname}
              openTickets={openTickets}
              urgentToday={urgentToday}
              onNavigate={onNavigate}
            />
          );
        }
        const hasActiveChild = entry.children.some((c) => isActive(c.href));
        const open = openGroups[entry.label] ?? hasActiveChild;
        const Icon = entry.icon;
        return (
          <div key={entry.label}>
            <button
              type="button"
              onClick={() => setOpenGroups((s) => ({ ...s, [entry.label]: !open }))}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                hasActiveChild
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {entry.label}
              <ChevronDown
                className={cn('ml-auto size-4 transition-transform', open ? '' : '-rotate-90')}
              />
            </button>
            {open && (
              <div className="mt-1 space-y-1">
                {entry.children.map((child) => (
                  <AdminNavLink
                    key={child.href}
                    item={child}
                    pathname={pathname}
                    openTickets={openTickets}
                    urgentToday={urgentToday}
                    onNavigate={onNavigate}
                    nested
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const admin = useAdminAuthStore((s) => s.superAdmin);
  const logout = useAdminLogout();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Tickets de soporte esperando respuesta del admin (badge en «Soporte»).
  const openTickets = useAdminOpenTicketsCount().data?.count ?? 0;
  const urgentToday = useAdminToday().data?.urgentCount ?? 0;
  const unreadNotifs = useAdminNotifUnreadCount().data?.count ?? 0;

  // Cierra el drawer al navegar a otra ruta.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  async function onLogout() {
    await logout.mutateAsync();
    router.replace('/admin/login');
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar fijo en desktop */}
      <aside className="hidden w-60 shrink-0 border-r border-border bg-muted/30 md:flex md:flex-col">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4 text-base font-semibold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/icon.svg" alt="TrasterOS" className="size-7 rounded-md shadow-sm" />
          TrasterOS Admin
        </div>
        <AdminNavLinks pathname={pathname} openTickets={openTickets} urgentToday={urgentToday} />
      </aside>

      {/* Drawer del sidebar en móvil */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="flex h-14 items-center gap-2 border-b border-border px-4 text-base font-semibold tracking-tight">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/icon.svg" alt="TrasterOS" className="size-7 rounded-md shadow-sm" />
            TrasterOS Admin
          </SheetTitle>
          <AdminNavLinks
            pathname={pathname}
            openTickets={openTickets}
            urgentToday={urgentToday}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-background px-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Abrir menú"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
            <div className="truncate text-sm font-medium text-muted-foreground">
              <span className="sm:hidden">Admin</span>
              <span className="hidden sm:inline">Panel super admin</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <AdminCommandPalette />
            <Link
              href="/admin/notifications"
              className="relative inline-flex size-9 items-center justify-center rounded-full hover:bg-accent"
              aria-label="Notificaciones"
            >
              <BellRing className="size-4" />
              {unreadNotifs > 0 && (
                <span className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium text-white">
                  {unreadNotifs}
                </span>
              )}
            </Link>
            <InstallPwaButton />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="size-9 rounded-full p-0"
                  aria-label="Menu de admin"
                >
                  <Avatar className="size-9">
                    <AvatarFallback>
                      {(admin?.fullName ?? 'A').slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="space-y-0.5">
                  <p className="truncate text-sm">{admin?.fullName ?? '...'}</p>
                  <p className="truncate text-xs font-normal text-muted-foreground">
                    {admin?.email ?? ''}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/admin/security">
                    <ShieldCheck className="mr-2 size-4" aria-hidden />
                    Seguridad (2FA)
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onLogout} disabled={logout.isPending}>
                  <LogOut className="mr-2 size-4" aria-hidden />
                  Cerrar sesión
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="min-w-0 flex-1">
          <SupportReadOnlyNotice pathname={pathname} />
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Aviso para el rol `support` en las secciones que solo puede consultar: el
 * API le responde 403 al guardar o cobrar, así que se lo decimos antes.
 */
function SupportReadOnlyNotice({ pathname }: { pathname: string }) {
  const isSuperadmin = useIsSuperadmin();
  const admin = useAdminAuthStore((s) => s.superAdmin);
  if (!admin || isSuperadmin) return null;
  const readOnly = SUPERADMIN_ONLY_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!readOnly) return null;
  return (
    <div className="mx-4 mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:mx-6 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      Con el rol de soporte puedes consultar esta sección, pero los cambios los hace un super admin.
    </div>
  );
}
