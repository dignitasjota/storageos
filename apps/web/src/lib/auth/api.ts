import { env } from '../env';

import { useAuthStore } from './store';

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly body: ApiErrorBody;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.statusCode = body.statusCode;
    this.body = body;
  }
}

interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** Si `true` (default), añade `Authorization: Bearer` y reintenta tras refresh ante 401. */
  requiresAuth?: boolean;
  /** Cualquier objeto serializable a JSON; si se pasa, fija `Content-Type`. */
  json?: unknown;
  /**
   * Body multipart/form-data. El navegador fija automáticamente el header
   * `Content-Type` con el boundary correcto, así que NO lo seteamos a mano.
   */
  formData?: FormData;
}

let refreshInFlight: Promise<string | null> | null = null;

/** Lanza la rotacion del refresh token; deduplica si ya hay una en curso. */
async function performRefresh(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${env.apiUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        useAuthStore.getState().clear();
        return null;
      }
      const data = (await res.json()) as { accessToken: string };
      useAuthStore.getState().setAccessToken(data.accessToken);
      return data.accessToken;
    } catch {
      useAuthStore.getState().clear();
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
  options: ApiFetchOptions,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (options.json !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.requiresAuth !== false) {
    const token = useAuthStore.getState().accessToken;
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }
  return fetch(input, {
    ...init,
    headers,
    credentials: 'include',
  });
}

/**
 * Cliente HTTP central. Maneja Bearer automatico, JSON-encoding, errores
 * uniformes y refresh transparente ante 401.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${env.apiUrl}${path}`;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
    ...(options.formData !== undefined ? { body: options.formData } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let res = await executeFetch(url, init, options);

  if (res.status === 401 && options.requiresAuth !== false) {
    // Posible token caducado o aun no bootstrapped. Intentamos refresh.
    const refreshed = await performRefresh();
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
