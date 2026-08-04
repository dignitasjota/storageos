'use client';

import { usePathname } from 'next/navigation';

import type { ReactNode } from 'react';

import { CookieBanner } from '@/components/public/cookie-banner';
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
 */
export function PublicChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const bare =
    pathname?.startsWith('/portal') ||
    pathname?.startsWith('/s/') ||
    pathname?.startsWith('/book/') ||
    pathname?.startsWith('/sign/');
  if (bare) {
    return <main className="flex min-h-screen flex-col">{children}</main>;
  }
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <PublicFooter />
      <CookieBanner />
    </div>
  );
}
