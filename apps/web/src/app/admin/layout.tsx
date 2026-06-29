'use client';

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Building2,
  Gauge,
  HeartPulse,
  Layers,
  LifeBuoy,
  LogOut,
  Megaphone,
  ScrollText,
  ShieldCheck,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeProvider } from 'next-themes';
import { useEffect, type ReactNode } from 'react';

import type { SuperAdminDto, SuperAdminRefreshResponse } from '@storageos/shared';

import { ThemeToggle } from '@/components/layout/theme-toggle';
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
import { adminApiFetch } from '@/lib/admin/api';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import { useAdminLogout } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';

interface AdminNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin/metrics', label: 'Métricas', icon: BarChart3 },
  { href: '/admin/tenants', label: 'Tenants', icon: Building2 },
  { href: '/admin/health', label: 'Salud', icon: HeartPulse },
  { href: '/admin/adoption', label: 'Adopción', icon: TrendingUp },
  { href: '/admin/at-risk', label: 'En riesgo', icon: AlertTriangle },
  { href: '/admin/announcements', label: 'Anuncios', icon: Megaphone },
  { href: '/admin/support', label: 'Soporte', icon: LifeBuoy },
  { href: '/admin/security-dashboard', label: 'Dashboard seguridad', icon: Gauge },
  { href: '/admin/security-events', label: 'Eventos de seguridad', icon: Activity },
  { href: '/admin/audit-logs', label: 'Audit logs', icon: ScrollText },
  { href: '/admin/queues', label: 'Sistema', icon: Layers },
  { href: '/admin/webhooks-cleanup', label: 'Cleanup webhooks', icon: Trash2 },
  { href: '/admin/security', label: 'Seguridad', icon: ShieldCheck },
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
export default function AdminLayout({ children }: { children: ReactNode }) {
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
      {pathname === '/admin/login' ? (
        <div className="min-h-screen bg-background">{children}</div>
      ) : (
        <AdminGuard>
          <AdminShell>{children}</AdminShell>
        </AdminGuard>
      )}
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
        // Otros errores: no rompemos la app, dejamos al usuario reintentar.
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

  if (isBootstrapping || !token) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Cargando panel...
      </div>
    );
  }

  return <>{children}</>;
}

function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const admin = useAdminAuthStore((s) => s.superAdmin);
  const logout = useAdminLogout();

  async function onLogout() {
    await logout.mutateAsync();
    router.replace('/admin/login');
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-muted/30 md:flex md:flex-col">
        <div className="flex h-14 items-center border-b border-border px-4 text-base font-semibold tracking-tight">
          StorageOS Admin
        </div>
        <nav className="flex-1 space-y-1 px-2 py-3">
          {ADMIN_NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-background px-4">
          <div className="text-sm font-medium text-muted-foreground">Panel super admin</div>
          <div className="flex items-center gap-1">
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
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
