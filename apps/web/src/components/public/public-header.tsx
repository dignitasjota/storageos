'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { PlatformLogo } from '@/components/public/platform-logo';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/auth/store';

const NAV = [
  { href: '/#funcionalidades', key: 'features' },
  { href: '/#para-quien', key: 'audiences' },
  { href: '/#precios', key: 'pricing' },
  { href: '/#faq', key: 'faq' },
] as const;

/** Cabecera de la web de TrasterOS: fondo del color de marca y logo configurable. */
export function PublicHeader({
  logoUrl,
  hasContact = false,
}: {
  logoUrl: string | null;
  hasContact?: boolean;
}) {
  const t = useTranslations('publicHeader');
  const common = useTranslations('common');
  const pathname = usePathname();
  const accessToken = useAuthStore((s) => s.accessToken);
  const isBootstrapping = useAuthStore((s) => s.isBootstrapping);
  const showAppCta = !isBootstrapping && accessToken !== null;
  // En el portal del inquilino (acceso por magic link) no tienen sentido los
  // CTA de iniciar sesión / crear cuenta del staff.
  const isPortal = pathname?.startsWith('/portal') ?? false;
  const nav = hasContact ? [...NAV, { href: '/#contacto', key: 'contact' } as const] : NAV;

  return (
    <header className="sticky top-0 z-30 bg-primary text-primary-foreground shadow-sm">
      <div className="container flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex shrink-0 items-center" aria-label={common('appName')}>
          <PlatformLogo logoUrl={logoUrl} className="h-7 sm:h-8" />
        </Link>
        {!isPortal && (
          <nav className="hidden items-center gap-1 lg:flex" aria-label="Principal">
            {nav.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="rounded-md px-3 py-2 text-sm font-medium text-primary-foreground/85 transition hover:bg-white/10 hover:text-primary-foreground"
              >
                {t(`nav.${item.key}`)}
              </Link>
            ))}
          </nav>
        )}
        <nav className="flex items-center gap-2">
          {isPortal ? null : showAppCta ? (
            <Button asChild className="bg-white text-primary hover:bg-white/90">
              <Link href="/dashboard">{t('goToApp')}</Link>
            </Button>
          ) : (
            <>
              <Button
                asChild
                variant="ghost"
                className="hidden text-primary-foreground hover:bg-white/10 hover:text-primary-foreground sm:inline-flex"
              >
                <Link href="/login">{t('login')}</Link>
              </Button>
              <Button asChild className="bg-white text-primary shadow-sm hover:bg-white/90">
                <Link href="/register">{t('register')}</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
