import { ApiError, type ApiErrorBody } from '../auth/api';
import { env } from '../env';

/**
 * Prefija `/v1` igual que en el cliente tenant (`auth/api.ts`). Mantener
 * la logica duplicada (en vez de importar) para no acoplar este modulo
 * a detalles internos del otro y poder cambiar reglas si admin diverge.
 */
function withVersion(path: string): string {
  if (path.startsWith('http')) return path;
  if (
    path.startsWith('/v1/') ||
    path === '/v1' ||
    path === '/health' ||
    path.startsWith('/webhooks/') ||
    path.startsWith('/public/widget/')
  ) {
    return path;
  }
  return `/v1${path.startsWith('/') ? '' : '/'}${path}`;
}

import { useAdminAuthStore } from './auth-store';

import type { SuperAdminRefreshResponse } from '@storageos/shared';

interface AdminFetchOptions extends Omit<RequestInit, 'body'> {
  /** Si `true` (default), añade `Authorization: Bearer` del super admin token. */
  requiresAuth?: boolean;
  /** Cualquier objeto serializable a JSON; si se pasa, fija `Content-Type`. */
  json?: unknown;
}

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Lanza la rotacion del refresh token via cookie httpOnly; deduplica si ya
 * hay una en curso. Devuelve el nuevo accessToken o null si el refresh falla.
 */
async function performAdminRefresh(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${env.apiUrl}${withVersion('/admin/auth/refresh')}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        useAdminAuthStore.getState().clear();
        return null;
      }
      const data = (await res.json()) as SuperAdminRefreshResponse;
      useAdminAuthStore.getState().setAccessToken(data.accessToken);
      return data.accessToken;
    } catch {
      useAdminAuthStore.getState().clear();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function parseJsonOrThrow(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError({
      statusCode: res.status,
      error: 'Bad Response',
      message: 'Respuesta no es JSON valido',
    });
  }
}

async function executeFetch(
  input: string,
  init: RequestInit,
  options: AdminFetchOptions,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (options.json !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.requiresAuth !== false) {
    const token = useAdminAuthStore.getState().superAdminToken;
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }
  return fetch(input, {
    ...init,
    headers,
    // La cookie de refresh super_admin_refresh debe viajar con cada request.
    credentials: 'include',
  });
}

/**
 * Cliente HTTP para el panel super admin.
 *
 * Comportamiento clave:
 *   - Access token en memoria (Zustand) — NO se persiste.
 *   - Refresh via cookie httpOnly (`super_admin_refresh`) automatica gracias
 *     a `credentials: 'include'`.
 *   - Ante 401, intenta UN refresh transparente; si funciona, reintenta la
 *     request original. Si falla, limpia store y devuelve el 401.
 *   - Refreshes concurrentes se deduplican a una unica promise compartida.
 *
 * Compartimos `ApiError` con el cliente tenant para que los componentes
 * puedan reutilizar el mismo manejo de errores.
 */
export async function adminApiFetch<T = unknown>(
  path: string,
  options: AdminFetchOptions = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${env.apiUrl}${withVersion(path)}`;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let res = await executeFetch(url, init, options);

  if (res.status === 401 && options.requiresAuth !== false) {
    const refreshed = await performAdminRefresh();
    if (refreshed) {
      res = await executeFetch(url, init, options);
    }
  }

  if (!res.ok) {
    const body = (await parseJsonOrThrow(res).catch(() => ({}))) as Partial<ApiErrorBody>;
    throw new ApiError({
      statusCode: body.statusCode ?? res.status,
      error: body.error ?? res.statusText,
      message: body.message ?? 'Error de la API',
      ...(body.details ? { details: body.details } : {}),
    });
  }

  return (await parseJsonOrThrow(res)) as T;
}
