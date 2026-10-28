import { ApiError, apiFetch } from '@/lib/auth/api';

/** Evento que lanza cualquier llamada del portal cuando la sesión ya no vale. */
export const PORTAL_UNAUTHORIZED_EVENT = 'portal:unauthorized';

/**
 * `apiFetch` para las tarjetas del portal: si la sesión del inquilino caduca
 * o el equipo la cierra (401), avisa a la página para que pida volver a
 * entrar, en vez de dejar la tarjeta vacía sin explicación.
 */
export function portalApiFetch<T>(
  path: string,
  options: Parameters<typeof apiFetch>[1] = {},
): Promise<T> {
  return apiFetch<T>(path, options).catch((err: unknown) => {
    if (err instanceof ApiError && err.statusCode === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(PORTAL_UNAUTHORIZED_EVENT, {
          detail: { code: err.body.code, message: err.body.message },
        }),
      );
    }
    throw err;
  });
}
