'use client';

import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Estado de error consistente para las páginas del panel super admin. Muestra
 * un mensaje + botón «Reintentar» que dispara el `refetch` de la query. Evita
 * que un fallo de red se confunda con «cargando» (spinner infinito) o «vacío»
 * (mensaje engañoso).
 */
export function AdminError({
  onRetry,
  message = 'No se pudieron cargar los datos.',
}: {
  onRetry: () => void;
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <AlertTriangle className="size-8 text-amber-500" aria-hidden />
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}
