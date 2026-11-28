import { isTenantFacingPath } from '@storageos/shared';
import { ArrowRight } from 'lucide-react';
import { headers } from 'next/headers';
import Link from 'next/link';

import type { Metadata } from 'next';

import { PlatformLogo } from '@/components/public/platform-logo';
import { fetchPlatformWebsite } from '@/lib/platform-website';

/**
 * Página 404 de la plataforma de TrasterOS, en español y con la marca.
 *
 * Las webs de los negocios (`/s/…`, `/book/…`, los dominios propios…) también
 * pasan por aquí cuando algo no existe: en ese caso se mantiene la página
 * neutral de siempre (no es la marca de TrasterOS la que tiene que verse).
 * Quién pide la página se sabe por la cabecera que pone el middleware.
 */
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  if (isNeutralRequest(h)) {
    return { title: { absolute: '404: This page could not be found.' }, robots: { index: false } };
  }
  return { title: { absolute: 'Página no encontrada · TrasterOS' }, robots: { index: false } };
}

/** ¿Es una web de un negocio? Esas se quedan con la página neutral de siempre. */
function isNeutralRequest(h: Awaited<ReturnType<typeof headers>>): boolean {
  return (
    Boolean(h.get('x-storageos-tenant-slug')) ||
    isTenantFacingPath(h.get('x-storageos-pathname') ?? '')
  );
}

export default async function NotFound() {
  if (isNeutralRequest(await headers())) {
    return <TenantNotFound />;
  }
  const { logoUrl } = await fetchPlatformWebsite();
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="bg-primary text-primary-foreground">
        <div className="container flex h-16 items-center">
          <Link href="/" aria-label="TrasterOS">
            <PlatformLogo logoUrl={logoUrl} className="h-8" fallbackClassName="h-7" />
          </Link>
        </div>
      </header>
      <main className="container flex flex-1 flex-col items-center justify-center gap-6 py-16 text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Error 404</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Esta página no existe</h1>
        <p className="max-w-md text-muted-foreground">
          La dirección que has escrito no está disponible o se ha movido. Vuelve a la portada de
          TrasterOS para encontrar lo que buscas.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          Ir a la portada
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </main>
    </div>
  );
}

/** Página neutral de los negocios (la misma que sirve Next por defecto). */
function TenantNotFound() {
  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <p style={{ margin: 0, fontSize: 14 }}>404 | This page could not be found.</p>
    </div>
  );
}
