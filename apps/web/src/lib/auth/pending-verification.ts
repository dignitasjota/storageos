/**
 * Datos del alta que esperan a la verificación del email («Revisa tu correo»).
 * Van en `sessionStorage` y no en la URL: las direcciones de las páginas
 * acaban en las analíticas y en el historial del navegador, y el email es un
 * dato personal. Vive solo en la pestaña; si se pierde, la página pide reenviar
 * con el formulario o volver a entrar.
 */
export interface PendingVerification {
  email: string;
  tenantSlug: string;
}

const KEY = 'storageos.auth.pendingVerification';

export function savePendingVerification(value: PendingVerification): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Sin sessionStorage (modo privado estricto): la página no podrá reenviar.
  }
}

export function readPendingVerification(): PendingVerification | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingVerification>;
    if (typeof parsed.email !== 'string' || typeof parsed.tenantSlug !== 'string') return null;
    return { email: parsed.email, tenantSlug: parsed.tenantSlug };
  } catch {
    return null;
  }
}
