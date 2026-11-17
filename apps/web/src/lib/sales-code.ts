'use client';

import { normalizeSalesCode, SALES_CODE_PARAM, SALES_CODE_TTL_DAYS } from '@storageos/shared';

const KEY = 'storageos.salesCode';

/** Guarda el código del enlace o el QR del comercial (90 días). */
export function rememberSalesCode(raw: string | null | undefined): void {
  const code = normalizeSalesCode(raw);
  if (!code || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // Almacenamiento bloqueado: el código solo valdrá en esta página.
  }
}

/** El código del comercial que trajo la visita (si no ha caducado). */
export function storedSalesCode(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: string; at?: number };
    if (!v.code || !v.at || Date.now() - v.at > SALES_CODE_TTL_DAYS * 86_400_000) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return normalizeSalesCode(v.code);
  } catch {
    return null;
  }
}

/** Lee `?team=` de la URL actual y lo guarda. */
export function captureSalesCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const code = normalizeSalesCode(
    new URLSearchParams(window.location.search).get(SALES_CODE_PARAM),
  );
  if (code) rememberSalesCode(code);
  return code;
}

/** Código a mandar con un formulario de la web (el del enlace del comercial). */
export function salesCodeFields(): { salesCode?: string } {
  const code = storedSalesCode();
  return code ? { salesCode: code } : {};
}
