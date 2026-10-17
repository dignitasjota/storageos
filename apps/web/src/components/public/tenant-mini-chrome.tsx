import type { ReactNode } from 'react';

const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';

export interface TenantMiniBrand {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
}

/**
 * Marco mínimo con la marca del negocio para las páginas sueltas que ve el
 * inquilino fuera de su web (valoración, vuelta del pago con Redsys). Sin
 * hooks: vale en servidor y en cliente. Sin marca conocida, solo el contenido.
 */
export function TenantMiniChrome({
  brand,
  children,
}: {
  brand: TenantMiniBrand | null;
  children: ReactNode;
}) {
  if (!brand) return <>{children}</>;
  const color = brand.brandColor ?? '#2563EB';
  const portalHref = `/portal/login?slug=${encodeURIComponent(brand.tenantSlug)}`;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border/60" style={{ borderTop: `3px solid ${color}` }}>
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt={brand.tenantName} className="h-7 w-auto object-contain" />
          ) : (
            <span className="font-semibold">{brand.tenantName}</span>
          )}
          <a
            href={portalHref}
            className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white"
            style={{ backgroundColor: color }}
          >
            Área de clientes
          </a>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-3xl justify-between gap-2 px-4 py-4 text-xs text-muted-foreground">
          <span>
            © {new Date().getUTCFullYear()} {brand.tenantName}
          </span>
          <a href={SAAS_URL} target="_blank" rel="noopener noreferrer">
            Creado con TrasterOS
          </a>
        </div>
      </footer>
    </div>
  );
}
