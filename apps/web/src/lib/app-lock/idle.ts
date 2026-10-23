import { APP_LOCK_IDLE_MINUTES } from '@storageos/shared';

/**
 * Última vez que el usuario usó la app del panel (en este dispositivo). Vive
 * en `localStorage` para sobrevivir al cierre de la app: al volver a abrirla
 * pasados `APP_LOCK_IDLE_MINUTES`, se pide Face ID / huella o el PIN.
 */
const KEY = 'storageos.appLock.lastActive';

export function markAppActive(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Sin almacenamiento (modo privado): no se bloquea por inactividad.
  }
}

export function clearAppActivity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** ¿Ha pasado el tiempo de inactividad? Sin dato (recién entrado) no bloquea. */
export function appIdleExpired(now = Date.now()): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return false;
  }
  const last = raw ? Number(raw) : NaN;
  if (!Number.isFinite(last)) return false;
  return now - last >= APP_LOCK_IDLE_MINUTES * 60_000;
}
