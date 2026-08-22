'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';

import { PortalLanguageSwitcher } from '../i18n/language-switcher';

import type { PortalSessionDto, PublicTenantBrandDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

const PORTAL_SESSION_KEY = 'storageos.portal.session';
const PORTAL_LOCALE_KEY = 'storageos.portal.locale';
const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';

function storePortalSession(s: PortalSessionDto): void {
  try {
    localStorage.setItem(
      PORTAL_SESSION_KEY,
      JSON.stringify({ ...s, expiresAtMs: Date.now() + s.expiresIn * 1000 }),
    );
    localStorage.setItem(PORTAL_LOCALE_KEY, s.locale);
  } catch {
    /* localStorage no disponible */
  }
}

function ResetForm() {
  const t = useTranslations('portal.reset');
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error(t('passwordTooShort'));
      return;
    }
    if (password !== confirm) {
      toast.error(t('passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      const session = await apiFetch<PortalSessionDto>('/portal/login/reset', {
        method: 'POST',
        json: { token, password },
        requiresAuth: false,
      });
      storePortalSession(session);
      window.location.href = '/portal/consume';
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('invalidOrExpired'));
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="space-y-3 text-center text-sm">
        <p>{t('invalidLink')}</p>
        <Button variant="outline" asChild>
          <a href="/portal/login">{t('goToLogin')}</a>
        </Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div>
        <Label>{t('newPasswordLabel')}</Label>
        <Input
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
          className="text-base sm:text-sm"
        />
      </div>
      <div>
        <Label>{t('confirmPasswordLabel')}</Label>
        <Input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
          className="text-base sm:text-sm"
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading || !password || !confirm}>
        {loading ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}

/**
 * La marca (logo/color) llega resuelta por el server component (`page.tsx`):
 * el enlace de reset ya apunta al dominio propio del tenant cuando está
 * verificado (`PortalService.portalBaseUrl`), así que la cabecera que fija
 * el middleware para ese dominio identifica al tenant aquí también.
 */
export function PortalResetClient({ initialBrand }: { initialBrand: PublicTenantBrandDto | null }) {
  const t = useTranslations('portal.reset');
  const tChrome = useTranslations('portal.chrome');
  const brand = initialBrand;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3">
          {brand ? (
            <Link
              href={`/s/${brand.tenantSlug}`}
              className="flex items-center gap-2 font-semibold"
              aria-label={brand.tenantName}
            >
              {brand.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={brand.logoUrl}
                  alt={brand.tenantName}
                  className="h-7 w-auto object-contain"
                />
              ) : (
                <span>{brand.tenantName}</span>
              )}
            </Link>
          ) : (
            <span />
          )}
          <PortalLanguageSwitcher />
        </div>
      </header>
      <div className="container flex flex-1 flex-col items-center gap-4 py-12">
        <Card className="w-full max-w-md border-border/60">
          <CardHeader className="space-y-2 text-center">
            <CardTitle className="text-2xl">
              {brand ? t('titleWithBrand', { tenantName: brand.tenantName }) : t('title')}
            </CardTitle>
            <CardDescription>{t('subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<p className="text-center text-sm text-muted-foreground">…</p>}>
              <ResetForm />
            </Suspense>
          </CardContent>
        </Card>
      </div>
      {brand && (
        <footer className="border-t border-border/60">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>
              © {new Date().getUTCFullYear()} {brand.tenantName}
            </p>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-foreground"
            >
              {tChrome('createdWith', { name: 'TrasterOS' })}
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}
