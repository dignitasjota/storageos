'use client';

import { useEffect, useState } from 'react';

import type { CSSProperties, ReactNode } from 'react';

const PORTAL_SESSION_KEY = 'storageos.portal.session';

/** ¿Queda una sesión del área de clientes guardada en este navegador? */
function hasPortalSession(): boolean {
  try {
    const raw = localStorage.getItem(PORTAL_SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw) as { accessToken?: string; expiresAtMs?: number };
    return !!s.accessToken && (s.expiresAtMs ?? 0) > Date.now() + 10_000;
  } catch {
    return false;
  }
}

/**
 * Enlace de vuelta al área de clientes tras pagar con Redsys: con la sesión
 * todavía abierta lleva directo a sus facturas; si no, al login del negocio.
 */
export function PortalReturnLink({
  tenantSlug,
  className,
  style,
  children,
}: {
  tenantSlug: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const loginHref = `/portal/login?slug=${encodeURIComponent(tenantSlug)}`;
  const [href, setHref] = useState(loginHref);
  useEffect(() => {
    if (hasPortalSession()) setHref('/portal/consume?tab=facturas');
  }, []);
  return (
    <a href={href} className={className} style={style}>
      {children}
    </a>
  );
}
