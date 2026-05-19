'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/auth/store';

export function PublicHeader() {
  const t = useTranslations('publicHeader');
  const common = useTranslations('common');
  const accessToken = useAuthStore((s) => s.accessToken);
  const isBootstrapping = useAuthStore((s) => s.isBootstrapping);
  const showAppCta = !isBootstrapping && accessToken !== null;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center justify-between">
        <Link href="/" className="text-base font-semibold tracking-tight">
          {common('appName')}
        </Link>
        <nav className="flex items-center gap-2">
          {showAppCta ? (
            <Button asChild>
              <Link href="/dashboard">{t('goToApp')}</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost">
                <Link href="/login">{t('login')}</Link>
              </Button>
              <Button asChild>
                <Link href="/register">{t('register')}</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
