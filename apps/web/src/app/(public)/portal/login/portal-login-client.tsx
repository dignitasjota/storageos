'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { PortalLanguageSwitcher } from '../i18n/language-switcher';

import type { PortalSessionDto, PublicTenantBrandDto } from '@storageos/shared';

import { IosInstallHint } from '@/components/pwa/ios-install-hint';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

const PORTAL_SESSION_KEY = 'storageos.portal.session';
const PORTAL_LOCALE_KEY = 'storageos.portal.locale';
const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';

/**
 * Persiste la sesión igual que `/portal/consume` para que ésta la recupere,
 * y sincroniza el idioma preferido del cliente (guardado en su perfil) como
 * preferencia local, para que el provider lo recupere sin esperar a que se
 * cargue el perfil.
 */
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

type Mode = 'link' | 'password';

/**
 * El slug del tenant y su marca (logo/color) llegan resueltos por el server
 * component (`page.tsx`): desde `?slug=` (enlace «Acceso clientes» de
 * nuestras plantillas) o, si se accede por el dominio propio del tenant,
 * desde la cabecera que fija el middleware — así el login se ve con su
 * aspecto white-label también cuando el inquilino teclea la URL a mano o
 * llega desde una web externa que el tenant aloja fuera de la plataforma.
 */
export function PortalLoginClient({
  initialSlug,
  initialBrand,
}: {
  initialSlug: string | null;
  initialBrand: PublicTenantBrandDto | null;
}) {
  const t = useTranslations('portal.login');
  const tChrome = useTranslations('portal.chrome');
  const [mode, setMode] = useState<Mode>('link');
  const [tenantSlug, setTenantSlug] = useState(initialSlug ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const brand = initialBrand;

  const brandColor = brand?.brandColor ?? undefined;
  const brandBtn = brandColor ? 'w-full text-white' : 'w-full';

  async function submitLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch<void>('/portal/login/request', {
        method: 'POST',
        json: { tenantSlug, email },
        requiresAuth: false,
      });
      setSent(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('genericError'));
    } finally {
      setLoading(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const session = await apiFetch<PortalSessionDto>('/portal/login/password', {
        method: 'POST',
        json: { tenantSlug, email, password },
        requiresAuth: false,
      });
      storePortalSession(session);
      // La página de consumo recupera la sesión de localStorage al montar.
      window.location.href = '/portal/consume';
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('wrongCredentials'));
      setLoading(false);
    }
  }

  async function forgot() {
    if (!tenantSlug || !email) {
      toast.error(t('missingFields'));
      return;
    }
    try {
      await apiFetch<void>('/portal/login/forgot', {
        method: 'POST',
        json: { tenantSlug, email },
        requiresAuth: false,
      });
      toast.success(t('forgotSuccess'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('genericError'));
    }
  }

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
            {sent ? (
              <div className="space-y-3 text-center text-sm">
                <p>{t('sentTo', { email })}</p>
                <p className="text-muted-foreground">{t('sentExpiry')}</p>
                <Button variant="outline" onClick={() => setSent(false)}>
                  {t('tryAnotherEmail')}
                </Button>
              </div>
            ) : (
              <>
                {/* Selector de método */}
                <div className="mb-4 grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setMode('link')}
                    className={`rounded px-3 py-1.5 font-medium transition ${
                      mode === 'link' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                    }`}
                  >
                    {t('modeLink')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('password')}
                    className={`rounded px-3 py-1.5 font-medium transition ${
                      mode === 'password' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                    }`}
                  >
                    {t('modePassword')}
                  </button>
                </div>

                <form
                  className="space-y-4"
                  onSubmit={mode === 'link' ? submitLink : submitPassword}
                  noValidate
                >
                  {!brand && (
                    <div>
                      <Label>{t('companyLabel')}</Label>
                      <Input
                        value={tenantSlug}
                        onChange={(e) => setTenantSlug(e.target.value)}
                        autoComplete="organization"
                        autoCapitalize="off"
                        placeholder={t('companyPlaceholder')}
                        className="text-base sm:text-sm"
                      />
                    </div>
                  )}
                  <div>
                    <Label>{t('emailLabel')}</Label>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      className="text-base sm:text-sm"
                    />
                  </div>
                  {mode === 'password' && (
                    <div>
                      <Label>{t('passwordLabel')}</Label>
                      <Input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        className="text-base sm:text-sm"
                      />
                    </div>
                  )}
                  <Button
                    type="submit"
                    className={brandBtn}
                    style={brandColor ? { backgroundColor: brandColor } : undefined}
                    disabled={
                      loading || !tenantSlug || !email || (mode === 'password' && !password)
                    }
                  >
                    {loading
                      ? mode === 'link'
                        ? t('submitSending')
                        : t('submitEntering')
                      : mode === 'link'
                        ? t('submitSendLink')
                        : t('submitEnter')}
                  </Button>
                </form>

                {mode === 'password' ? (
                  <p className="mt-4 text-center text-xs text-muted-foreground">
                    {t('forgotPrompt')}{' '}
                    <button
                      type="button"
                      className="underline hover:text-foreground"
                      onClick={() => void forgot()}
                    >
                      {t('forgotLink')}
                    </button>
                    .
                  </p>
                ) : (
                  <p className="mt-4 text-center text-xs text-muted-foreground">
                    {t('noPasswordHint')}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <div className="w-full max-w-md">
          <IosInstallHint />
        </div>
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
