'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';

import { env } from '../env';

import { useAuthStore } from './store';

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

  useEffect(() => {
    let cancelled = false;
    setBootstrapping(true);

    (async () => {
      try {
        const res = await fetch(`${env.apiUrl}/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (cancelled) return;
        if (!res.ok) {
          setAccessToken(null);
          router.replace('/login?reason=expired');
          return;
        }
        const data = (await res.json()) as { accessToken: string };
        setAccessToken(data.accessToken);
      } catch {
        if (cancelled) return;
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
    // El bootstrap se ejecuta una unica vez al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
