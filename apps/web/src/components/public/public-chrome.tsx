'use client';

import { usePathname } from 'next/navigation';

import type { ReactNode } from 'react';

import { CookieBanner } from '@/components/public/cookie-banner';
import { PublicFooter } from '@/components/public/public-footer';
import { PublicHeader } from '@/components/public/public-header';

/**
 * Marco de las páginas públicas (landing, booking, firma…). El **portal del
 * inquilino** (`/portal/*`) queda FUERA de este marco: tiene su propia
 * cabecera y su barra de navegación inferior fija, así que el header/footer de
 * marketing y el banner de cookies solo estorbaban (colisión con la bottom-nav
 * y ruptura de la sensación de "app"). Es un panel de sesión de primera parte,
 * sin cookies de terceros, por lo que tampoco necesita el banner.
 */
export function PublicChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/portal')) {
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
