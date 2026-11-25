import { ApiError } from '@/lib/auth/api';

/** Mensaje del API (ya en español) o uno genérico. */
export function seoErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.body.message) return err.body.message;
  return 'No se pudo hacer. Inténtalo de nuevo.';
}
