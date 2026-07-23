'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { PortalSessionDto } from '@storageos/shared';

import { IosInstallHint } from '@/components/pwa/ios-install-hint';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';

const PORTAL_SESSION_KEY = 'storageos.portal.session';

/** Persiste la sesión igual que `/portal/consume` para que ésta la recupere. */
function storePortalSession(s: PortalSessionDto): void {
  try {
    localStorage.setItem(
      PORTAL_SESSION_KEY,
      JSON.stringify({ ...s, expiresAtMs: Date.now() + s.expiresIn * 1000 }),
    );
  } catch {
    /* localStorage no disponible */
  }
}

type Mode = 'link' | 'password';

export default function PortalLoginPage() {
  const [mode, setMode] = useState<Mode>('link');
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

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
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
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
      toast.error(err instanceof ApiError ? err.body.message : 'Email o contraseña incorrectos');
      setLoading(false);
    }
  }

  async function forgot() {
    if (!tenantSlug || !email) {
      toast.error('Indica la empresa y el email.');
      return;
    }
    try {
      await apiFetch<void>('/portal/login/forgot', {
        method: 'POST',
        json: { tenantSlug, email },
        requiresAuth: false,
      });
      toast.success('Si el email pertenece a algún cliente, te enviamos un enlace para tu contraseña.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="container flex flex-col items-center gap-4 py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">Portal del inquilino</CardTitle>
          <CardDescription>
            Consulta tus facturas, paga online y gestiona tu cuenta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-3 text-center text-sm">
              <p>
                Hemos enviado un enlace a <strong>{email}</strong> (si pertenece a algún tenant).
              </p>
              <p className="text-muted-foreground">El enlace caduca en 30 minutos.</p>
              <Button variant="outline" onClick={() => setSent(false)}>
                Probar con otro email
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
                  Enlace por email
                </button>
                <button
                  type="button"
                  onClick={() => setMode('password')}
                  className={`rounded px-3 py-1.5 font-medium transition ${
                    mode === 'password' ? 'bg-background shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  Contraseña
                </button>
              </div>

              <form
                className="space-y-4"
                onSubmit={mode === 'link' ? submitLink : submitPassword}
                noValidate
              >
                <div>
                  <Label>Empresa (slug del tenant)</Label>
                  <Input
                    value={tenantSlug}
                    onChange={(e) => setTenantSlug(e.target.value)}
                    autoComplete="organization"
                    autoCapitalize="off"
                    placeholder="acme"
                    className="text-base sm:text-sm"
                  />
                </div>
                <div>
                  <Label>Email</Label>
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
                    <Label>Contraseña</Label>
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
                  className="w-full"
                  disabled={
                    loading || !tenantSlug || !email || (mode === 'password' && !password)
                  }
                >
                  {loading
                    ? mode === 'link'
                      ? 'Enviando...'
                      : 'Entrando...'
                    : mode === 'link'
                      ? 'Enviar enlace'
                      : 'Entrar'}
                </Button>
              </form>

              {mode === 'password' ? (
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  ¿Olvidaste la contraseña o aún no la tienes?{' '}
                  <button
                    type="button"
                    className="underline hover:text-foreground"
                    onClick={() => void forgot()}
                  >
                    Te enviamos un enlace para establecerla
                  </button>
                  .
                </p>
              ) : (
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Sin contraseña: te enviamos un enlace de acceso de un solo uso.
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
  );
}
