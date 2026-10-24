'use client';

import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Fingerprint, Loader2, Lock, ShieldCheck, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { unlockWithPasskey, unlockWithPin, useAppLockStatus } from '@/lib/app-lock/hooks';
import { appIdleExpired, clearAppActivity, markAppActive } from '@/lib/app-lock/idle';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import { useAuthStore } from '@/lib/auth/store';
import { isInstalledApp } from '@/lib/pwa/installed';

const HINT_DISMISSED_KEY = 'storageos.appLock.hintDismissed';

/**
 * En la app del panel instalada en el móvil (sesión de 90 días), tras unos
 * minutos sin uso se pide Face ID / huella o el PIN antes de enseñar nada. En
 * el navegador no hace nada. Sin Face ID ni PIN configurados, no bloquea (y
 * sugiere configurarlos).
 */
export function AppLockGate({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState(false);
  // `true` si al abrir/volver ya había pasado el tiempo sin uso.
  const [idleLocked, setIdleLocked] = useState(false);
  useEffect(() => {
    const app = isInstalledApp();
    setInstalled(app);
    if (!app) return;
    if (appIdleExpired()) setIdleLocked(true);
    else markAppActive();
  }, []);

  const status = useAppLockStatus(installed);
  const hasMethod = Boolean(status.data && (status.data.pinSet || status.data.passkeys.length > 0));

  // Actividad: al tocar o escribir, y al irse a segundo plano (lo último que
  // vio). Al volver a primer plano, se comprueba si toca bloquear.
  const lastMark = useRef(0);
  useEffect(() => {
    if (!installed) return;
    const touch = () => {
      if (idleLocked) return;
      const now = Date.now();
      if (now - lastMark.current < 15_000) return;
      lastMark.current = now;
      markAppActive();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!idleLocked) markAppActive();
      } else if (appIdleExpired()) {
        setIdleLocked(true);
      }
    };
    window.addEventListener('pointerdown', touch, { passive: true });
    window.addEventListener('keydown', touch);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [installed, idleLocked]);

  const unlock = useCallback(() => {
    markAppActive();
    setIdleLocked(false);
  }, []);

  if (installed && idleLocked) {
    if (status.isLoading) return <LockSplash />;
    // Sin forma de desbloquear (o no se pudo saber), no se bloquea.
    if (hasMethod && status.data) {
      return (
        <LockScreen
          pinSet={status.data.pinSet}
          hasPasskey={status.data.passkeys.length > 0}
          onUnlocked={unlock}
        />
      );
    }
  }

  return (
    <>
      {installed && status.data && !hasMethod ? <SetupHint /> : null}
      {children}
    </>
  );
}

function LockSplash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function LockScreen({
  pinSet,
  hasPasskey,
  onUnlocked,
}: {
  pinSet: boolean;
  hasPasskey: boolean;
  onUnlocked: () => void;
}) {
  const router = useRouter();
  const me = useMe();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState<'pin' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const passkeyOk = hasPasskey && browserSupportsWebAuthn();

  const goToLogin = useCallback(() => {
    useAuthStore.getState().clear();
    clearAppActivity();
    router.replace('/login?reason=locked');
  }, [router]);

  const handleError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError) {
      if (err.body.code === 'app_lock_exhausted' || err.statusCode === 401) {
        goToLogin();
        return;
      }
      setError(err.body.message);
      return;
    }
    setError(fallback);
  };

  const tryPasskey = async () => {
    setBusy('passkey');
    setError(null);
    try {
      await unlockWithPasskey();
      onUnlocked();
    } catch (err) {
      // Cancelar el diálogo de Face ID no es un error que mostrar.
      if (err instanceof Error && err.name === 'NotAllowedError') setError(null);
      else handleError(err, 'No se ha podido comprobar Face ID / huella');
    } finally {
      setBusy(null);
    }
  };

  const submitPin = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(pin)) {
      setError('Escribe tu PIN de 4 a 6 cifras');
      return;
    }
    setBusy('pin');
    setError(null);
    try {
      await unlockWithPin(pin);
      onUnlocked();
    } catch (err) {
      setPin('');
      handleError(err, 'No se ha podido comprobar el PIN');
    } finally {
      setBusy(null);
    }
  };

  const name = me.data?.user.fullName.split(' ')[0];

  return (
    <div className="pt-safe pb-safe flex min-h-screen flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-xs space-y-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Lock className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{name ? `Hola, ${name}` : 'App bloqueada'}</h1>
          <p className="text-sm text-muted-foreground">
            Por seguridad, desbloquea la app para seguir.
          </p>
        </div>

        {passkeyOk ? (
          <Button className="w-full" size="lg" onClick={tryPasskey} disabled={busy !== null}>
            {busy === 'passkey' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Fingerprint className="mr-2 h-4 w-4" />
            )}
            Desbloquear con Face ID / huella
          </Button>
        ) : null}

        {pinSet ? (
          <form onSubmit={submitPin} className="space-y-3">
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d*"
              maxLength={6}
              placeholder="PIN"
              aria-label="PIN de la app"
              className="text-center text-lg tracking-[0.5em]"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              autoFocus={!passkeyOk}
            />
            <Button
              type="submit"
              variant={passkeyOk ? 'outline' : 'default'}
              className="w-full"
              disabled={busy !== null}
            >
              {busy === 'pin' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Desbloquear con el PIN
            </Button>
          </form>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={goToLogin}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Entrar con mi contraseña
        </button>
      </div>
    </div>
  );
}

function SetupHint() {
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(HINT_DISMISSED_KEY) === '1');
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(HINT_DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
  };
  return (
    <div className="flex items-center gap-3 border-b bg-primary/5 px-4 py-2 text-sm">
      <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
      <p className="flex-1">
        La sesión de la app dura 90 días.{' '}
        <Link href="/settings/profile?tab=app-lock" className="font-medium text-primary underline">
          Protégela con Face ID, huella o un PIN
        </Link>
      </p>
      <button type="button" onClick={dismiss} aria-label="Cerrar aviso" className="p-1">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
