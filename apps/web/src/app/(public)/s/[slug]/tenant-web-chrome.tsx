import Link from 'next/link';

import type { ReactNode } from 'react';

const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';
const SAAS_NAME = 'TrasterOS';

/** Datos mínimos de marca del tenant (los comparten la landing y la página por local). */
interface TenantBrand {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
}

/**
 * Marco WHITE-LABEL de la web pública del tenant (`/s/[slug]` y su dominio
 * propio). Cabecera + pie del OPERADOR, sin la marca de la plataforma: el
 * «Acceso clientes» lleva al **portal del inquilino** (con el slug precargado),
 * nunca al login de la plataforma. La única referencia a la plataforma es un
 * discreto «Creado con TrasterOS» en el pie.
 */
export function TenantWebChrome({
  data,
  children,
}: {
  data: TenantBrand;
  children: ReactNode;
}) {
  const brand = data.brandColor ?? '#2563EB';
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const year = new Date().getUTCFullYear();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            {data.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.logoUrl}
                alt={data.tenantName}
                className="h-7 w-auto object-contain"
              />
            ) : (
              <span>{data.tenantName}</span>
            )}
          </div>
          <Link
            href={portalHref}
            className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ backgroundColor: brand }}
          >
            Acceso clientes
          </Link>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {data.tenantName}
          </p>
          <div className="flex items-center gap-4">
            <Link href={portalHref} className="transition hover:text-foreground">
              Acceso clientes
            </Link>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-foreground"
            >
              Creado con {SAAS_NAME}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
