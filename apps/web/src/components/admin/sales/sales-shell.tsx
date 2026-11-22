'use client';

import {
  BellRing,
  BookOpen,
  Building2,
  CalendarCheck,
  CalendarClock,
  ClipboardCheck,
  FileText,
  LogOut,
  Menu,
  QrCode,
  ShieldCheck,
  Sparkles,
  Target,
  UserPlus,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { ThemeToggle } from '@/components/layout/theme-toggle';
import { InstallPwaButton } from '@/components/pwa/install-pwa-button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import { useAdmin2faStatus, useAdminLogout } from '@/lib/admin/hooks';
import { useSalesUnreadCount } from '@/lib/admin/sales-hooks';
import { cn } from '@/lib/utils';

interface SalesNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
}

const SALES_NAV: SalesNavItem[] = [
  { href: '/admin/sales', label: 'Hoy', icon: CalendarCheck, exact: true },
  { href: '/admin/sales/appointments', label: 'Mis citas', icon: CalendarClock },
  { href: '/admin/sales/leads', label: 'Prospectos', icon: Target },
  { href: '/admin/sales/capture', label: 'Alta rápida', icon: UserPlus },
  { href: '/admin/sales/clients', label: 'Clientes', icon: Building2 },
  { href: '/admin/sales/offers', label: 'Propuestas', icon: FileText },
  { href: '/admin/sales/opportunities', label: 'Qué ofrecer', icon: Sparkles },
  { href: '/admin/sales/approvals', label: 'Peticiones', icon: ClipboardCheck },
  { href: '/admin/sales/results', label: 'Mis comisiones', icon: Wallet },
  { href: '/admin/sales/materials', label: 'Materiales', icon: BookOpen },
  { href: '/admin/sales/profile', label: 'Mi enlace y QR', icon: QrCode },
];

/** Rutas del panel que puede abrir un comercial (el resto le lleva a «Hoy»). */
export function salesPathAllowed(pathname: string): boolean {
  return (
    pathname === '/admin/sales' ||
    pathname.startsWith('/admin/sales/') ||
    pathname === '/admin/security'
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="scrollbar-subtle min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3">
      {SALES_NAV.map((item) => {
        const Icon = item.icon;
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
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
  );
}

/** Aviso a pantalla completa hasta que el comercial activa la verificación en dos pasos. */
function TwoFactorGate() {
  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5" />
            Activa la verificación en dos pasos
          </CardTitle>
          <CardDescription>
            Tu cuenta de comercial da acceso a datos de clientes, así que antes de empezar tienes
            que protegerla con un código del móvil (Google Authenticator, Authy, 1Password…). Es un
            minuto.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/admin/security">Activarla ahora</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Panel del comercial: su propio menú (cartera, propuestas, comisiones…) y su
 * campana. No monta nada del resto del panel de administración.
 */
export function SalesShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const admin = useAdminAuthStore((s) => s.superAdmin);
  const logout = useAdminLogout();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const status = useAdmin2faStatus();
  // La verificación es obligatoria salvo que la dirección se la haya quitado
  // (`required` del estado). Hasta saberlo no se pinta el panel.
  const statusKnown = !!status.data || !!admin?.twoFactorEnabled || status.isError;
  // Si no se ha podido saber, no se le pide (el servidor lo exige igualmente).
  const needsTwoFactor = status.data
    ? status.data.required && !status.data.enabled
    : status.isError
      ? false
      : !admin?.twoFactorEnabled;
  const ready = statusKnown && !needsTwoFactor;
  const unread = useSalesUnreadCount(ready).data?.count ?? 0;
  const allowed = salesPathAllowed(pathname);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Lo que no es del comercial le lleva a su «Hoy».
  useEffect(() => {
    if (!allowed) router.replace('/admin/sales');
  }, [allowed, router]);

  async function onLogout() {
    await logout.mutateAsync();
    router.replace('/admin/login');
  }

  const brand = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/icon.svg" alt="TrasterOS" className="size-7 rounded-md shadow-sm" />
      TrasterOS Comercial
    </>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-border bg-muted/30 md:flex md:flex-col">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 text-base font-semibold tracking-tight">
          {brand}
        </div>
        <NavLinks pathname={pathname} />
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-64 flex-col p-0">
          <SheetTitle className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 text-base font-semibold tracking-tight">
            {brand}
          </SheetTitle>
          <NavLinks pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
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
              Panel comercial
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/admin/sales/notifications"
              className="relative inline-flex size-9 items-center justify-center rounded-full hover:bg-accent"
              aria-label="Avisos"
            >
              <BellRing className="size-4" />
              {unread > 0 && (
                <span className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium text-white">
                  {unread}
                </span>
              )}
            </Link>
            <InstallPwaButton />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="size-9 rounded-full p-0" aria-label="Mi cuenta">
                  <Avatar className="size-9">
                    <AvatarFallback>
                      {(admin?.fullName ?? 'C').slice(0, 2).toUpperCase()}
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
                  <Link href="/admin/sales/profile">
                    <QrCode className="mr-2 size-4" aria-hidden />
                    Mi enlace y QR
                  </Link>
                </DropdownMenuItem>
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
          {!allowed ? null : pathname === '/admin/security' ? (
            children
          ) : !statusKnown ? null : needsTwoFactor ? (
            <TwoFactorGate />
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
