'use client';

import { usePathname } from 'next/navigation';

import type { UpdatePlatformFooterInput } from '@storageos/shared';
import type { ReactNode } from 'react';

import { CookieBanner } from '@/components/public/cookie-banner';
import { PlatformAnalytics } from '@/components/public/platform-analytics';
import { PublicFooter } from '@/components/public/public-footer';
import { PublicHeader } from '@/components/public/public-header';

/**
 * Marco de las páginas públicas de MARKETING de la plataforma (landing raíz,
 * legales…). Se EXCLUYEN del marco de plataforma:
 * - `/portal/*` (portal del inquilino): tiene su propia cabecera + bottom-nav.
 * - `/s/*` (web pública white-label del tenant), `/book/*` (reserva) y `/sign/*`
 *   (firma del contrato): NO deben mostrar el header/footer ni el login/registro
 *   de la plataforma — son el embudo del operador para sus inquilinos. Cada una
 *   pinta su propio marco (`TenantWebChrome`) con acceso al portal del inquilino.
 *
 * `forcedBare` lo fija el layout (server) cuando el middleware reescribió la
 * petición desde un dominio propio (la raíz `/` → `/s/<slug>`, `/reservar` →
 * `/book/<slug>`…): el rewrite es invisible para el navegador, así que
 * `usePathname()` seguiría viendo `/`/`/reservar` y NO detectaría el caso solo
 * con el prefijo de ruta.
 */
export function PublicChrome({
  children,
  forcedBare = false,
  logoUrl = null,
  hasContact = false,
  footer = null,
  analyticsId = null,
}: {
  children: ReactNode;
  forcedBare?: boolean;
  /** Logo de la web (panel admin → Web de TrasterOS); null = el de la marca. */
  logoUrl?: string | null;
  /** Hay formulario de contacto en la portada (enlace «Contacto»). */
  hasContact?: boolean;
  /** Pie gestionado desde el panel admin; null = el de por defecto. */
  footer?: UpdatePlatformFooterInput | null;
  /** Google Analytics 4 de la web (solo se carga con el consentimiento). */
  analyticsId?: string | null;
}) {
  const pathname = usePathname();
  const bare =
    forcedBare ||
    pathname?.startsWith('/portal') ||
    pathname?.startsWith('/s/') ||
    pathname?.startsWith('/book/') ||
    pathname?.startsWith('/sign/') ||
    pathname?.startsWith('/unsubscribe/');
  if (bare) {
    return <main className="flex min-h-screen flex-col">{children}</main>;
  }
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader logoUrl={logoUrl} hasContact={hasContact} />
      <main className="flex-1">{children}</main>
      <PublicFooter
        logoUrl={logoUrl}
        hasContact={hasContact}
        footer={footer}
        analytics={Boolean(analyticsId)}
      />
      <CookieBanner analytics={Boolean(analyticsId)} />
      {analyticsId && <PlatformAnalytics measurementId={analyticsId} />}
    </div>
  );
}
