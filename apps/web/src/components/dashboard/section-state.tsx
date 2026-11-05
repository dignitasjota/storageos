'use client';

import { AlertCircle, Loader2 } from 'lucide-react';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

/** Una sección que no se pudo cargar: dice que falló, nunca que no hay nada. */
export function SectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
      <AlertCircle className="size-5 text-amber-500" />
      <p>No se ha podido cargar. Los datos no están al día.</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}

/** Carga, error o contenido de una sección del Resumen. */
export function SectionBody<T>({
  loading,
  data,
  onRetry,
  height = 'h-64',
  children,
}: {
  loading: boolean;
  data: T | null | undefined;
  onRetry: () => void;
  height?: string;
  children: (data: T) => ReactNode;
}) {
  if (loading) {
    return (
      <div className={`flex items-center justify-center ${height}`}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (data === null || data === undefined) return <SectionError onRetry={onRetry} />;
  return <>{children(data)}</>;
}
