'use client';

import { Loader2, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { RefreshUnavailableError, performRefresh } from './api';
import { claimImpersonation } from './impersonation';
import { useAuthStore } from './store';

import { Button } from '@/components/ui/button';

/**
 * Al montarse, dispara una llamada a `/auth/refresh` para recuperar el
 * access token desde la cookie httpOnly. Si funciona, lo guarda en el
 * store en memoria; si no, limpia el store y redirige a `/login`.
 *
 * Se monta dentro del layout `(app)` para que solo aplique cuando el
 * usuario navega a rutas autenticadas.
 *
 * MIENTRAS se rehidrata la sesión (o si ha fallado y aún no se ha
 * completado la redirección) NO montamos los `children`: si lo hiciéramos,
 * toda la app autenticada dispararía sus `useQuery` sin token todavía → una
 * ráfaga de 401 (uno por endpoint) + un refresh por cada uno. Gateando el
 * render, en la carga normal no hay ningún 401 (los children montan ya con
 * token) y en la sesión caducada se ve un loader limpio → login, no un muro
 * de errores en consola.
 */
export function AuthBootstrap({ children }: { children: ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isBootstrapping = useAuthStore((s) => s.isBootstrapping);
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const setBootstrapping = useAuthStore((s) => s.setBootstrapping);
  const router = useRouter();

  // Sin conexión al abrir: la sesión sigue guardada, se reintenta en vez de
  // mandar al login (en el móvil la red tarda en volver al abrir la app).
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setBootstrapping(true);

    (async () => {
      // Refresh deduplicado (comparte promesa con `apiFetch`): nunca dos
      // `/auth/refresh` en paralelo con la misma cookie.
      // Sesión de soporte abierta desde el panel admin: usa su token tal cual.
      const impersonation = claimImpersonation();
      if (impersonation) {
        setAccessToken(impersonation.accessToken);
        setBootstrapping(false);
        return;
      }
      try {
        const token = await performRefresh();
        if (cancelled) return;
        setOffline(false);
        if (!token) {
          setAccessToken(null);
          router.replace('/login?reason=expired');
          return;
        }
        setAccessToken(token);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RefreshUnavailableError) {
          setOffline(true);
          return;
        }
        setAccessToken(null);
        router.replace('/login?reason=expired');
      } finally {
        if (!cancelled) {
          setBootstrapping(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Se repite solo al reintentar tras quedarse sin conexión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Sin conexión: reintenta al volver la red y cada 10 s.
  useEffect(() => {
    if (!offline) return;
    window.addEventListener('online', retry);
    const timer = window.setInterval(retry, 10_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(timer);
    };
  }, [offline, retry]);

  if (offline && !accessToken) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <WifiOff className="size-8 text-muted-foreground" />
        <p className="font-medium">Sin conexión</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          No se puede conectar con el servidor. Tu sesión sigue abierta: en cuanto vuelva la
          conexión entrarás sin tener que iniciar sesión.
        </p>
        <Button variant="outline" onClick={retry}>
          Reintentar
        </Button>
      </div>
    );
  }

  // Hasta tener sesión rehidratada no montamos la app (evita la ráfaga de 401).
  // Si el refresh falló, `router.replace('/login')` ya está en marcha y este
  // loader se desmonta al navegar.
  if (isBootstrapping || !accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
