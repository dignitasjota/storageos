'use client';

import { useEffect } from 'react';

/**
 * Fallo al pintar la web del negocio o su reserva (un navegador antiguo, un
 * dato raro…): se ofrece volver a cargarla en vez de dejar la página en blanco.
 * Va un nivel por encima de `[slug]` para cubrir también su layout.
 */
export default function TenantSiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Para el registro del navegador; el visitante solo ve el aviso.
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold">No se ha podido cargar la página</h1>
      <p className="text-sm text-muted-foreground">
        Puede ser un problema pasajero. Vuelve a intentarlo; si sigue igual, prueba con otro
        navegador.
      </p>
      <button
        type="button"
        onClick={reset}
        className="h-10 rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90"
      >
        Volver a intentarlo
      </button>
    </main>
  );
}
