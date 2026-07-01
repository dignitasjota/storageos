import type { ReactNode } from 'react';

/** Contenedor de presentación para las páginas legales (términos, privacidad). */
export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div className="container max-w-3xl py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Última actualización: {lastUpdated}</p>
      <div className="mt-8">{children}</div>
    </div>
  );
}

/** Formatea la fecha de última actualización (ISO → es-ES), o un valor por defecto. */
export function formatLegalDate(iso: string | null): string {
  if (!iso) return '2 de julio de 2026';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
