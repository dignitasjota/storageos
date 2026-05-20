'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';

import { env } from '../env';

import { useAuthStore } from './store';

/**
 * Al montarse, dispara una llamada a `/auth/refresh` para recuperar el
 * access token desde la cookie httpOnly. Si funciona, lo guarda en el
 * store en memoria; si no, limpia el store y deja al middleware/UI
 * redirigir a `/login`.
 *
 * Se monta dentro del layout `(app)` para que solo aplique cuando el
 * usuario navega a rutas autenticadas.
 */
export function AuthBootstrap({ children }: { children: ReactNode }) {
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

  return <>{children}</>;
}
