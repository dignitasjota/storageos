import { AsyncLocalStorage } from 'node:async_hooks';

/** Sesión de impersonación de la request en curso, para marcar lo que se audita. */
export const impersonationContext = new AsyncLocalStorage<{ impersonationId: string }>();
