/**
 * Sesión de impersonación del soporte de TrasterOS en el panel del tenant.
 *
 * El panel admin deja el token en `localStorage` (mismo origen) con un código
 * de un solo uso y abre `/dashboard?impersonation=<código>`. La pestaña nueva
 * lo recoge solo si el código coincide (otra pestaña del panel que arranque en
 * ese momento no se lo queda), lo borra de `localStorage` y lo guarda en
 * `sessionStorage`: vale para esa pestaña, sobrevive a recargar y no se
 * comparte con otras. Nunca se usa la cookie de refresh: al caducar, se acaba.
 */
export const IMPERSONATION_HANDOFF_KEY = 'storageos:impersonation';
const SESSION_KEY = 'storageos.impersonation';
export const IMPERSONATION_URL_PARAM = 'impersonation';

export interface ImpersonationSession {
  accessToken: string;
  tenantName: string;
  tenantSlug: string;
  /** Epoch ms. */
  expiresAt: number;
  readOnly: boolean;
}

interface Handoff extends ImpersonationSession {
  nonce: string;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function valid(s: ImpersonationSession | null): s is ImpersonationSession {
  return !!s && typeof s.accessToken === 'string' && s.expiresAt > Date.now();
}

/** Sesión de impersonación de esta pestaña (o null). */
export function getImpersonation(): ImpersonationSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const s = parse<ImpersonationSession>(window.sessionStorage.getItem(SESSION_KEY));
    if (valid(s)) return s;
    if (s) window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Almacenamiento bloqueado: sin impersonación.
  }
  return null;
}

/**
 * Recoge la sesión que dejó el panel admin si la URL trae su código, y si no,
 * la que ya tenía esta pestaña.
 */
export function claimImpersonation(): ImpersonationSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const nonce = url.searchParams.get(IMPERSONATION_URL_PARAM);
    if (nonce) {
      url.searchParams.delete(IMPERSONATION_URL_PARAM);
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      const handoff = parse<Handoff>(window.localStorage.getItem(IMPERSONATION_HANDOFF_KEY));
      if (handoff && handoff.nonce === nonce) {
        window.localStorage.removeItem(IMPERSONATION_HANDOFF_KEY);
        if (valid(handoff)) {
          const session: ImpersonationSession = {
            accessToken: handoff.accessToken,
            tenantName: handoff.tenantName,
            tenantSlug: handoff.tenantSlug,
            expiresAt: handoff.expiresAt,
            readOnly: handoff.readOnly === true,
          };
          window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
          setMarkerCookie(session.expiresAt);
          return session;
        }
      }
    }
  } catch {
    // Sin almacenamiento no hay impersonación.
  }
  return getImpersonation();
}

/** Termina la impersonación en esta pestaña. */
export function endImpersonation(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // nada
  }
  document.cookie = `${MARKER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Marca para el middleware (que manda al login sin cookie de sesión). No lleva
 * el token ni da acceso a nada: solo deja cargar la página.
 */
const MARKER_COOKIE = 'storageos_impersonation';
function setMarkerCookie(expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  document.cookie = `${MARKER_COOKIE}=1; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

/** Fin de la sesión: borra el token y lleva a la página de despedida. */
export function leaveImpersonation(): void {
  endImpersonation();
  if (typeof window === 'undefined') return;
  window.location.replace('/impersonation-ended');
}
