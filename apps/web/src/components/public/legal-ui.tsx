import type { ReactNode } from 'react';

/**
 * Contenedores de presentación para las páginas legales (términos, privacidad).
 * Estilo sobrio y legible sin depender del plugin `typography`.
 */
export function LegalPage({
  title,
  lastUpdated,
  intro,
  children,
}: {
  title: string;
  lastUpdated: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="container max-w-3xl py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Última actualización: {lastUpdated}</p>
      {intro ? (
        <div className="mt-6 text-sm leading-relaxed text-foreground/80">{intro}</div>
      ) : null}
      <div className="mt-8 space-y-8">{children}</div>
    </div>
  );
}

export function LegalSection({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">
        {n}. {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/80">{children}</div>
    </section>
  );
}

export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** Marca un dato que el prestador debe completar (razón social, NIF, etc.). */
export function Fill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-amber-100 px-1 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {children}
    </span>
  );
}
