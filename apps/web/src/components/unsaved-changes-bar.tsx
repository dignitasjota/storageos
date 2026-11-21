'use client';

import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Barra pegada abajo cuando la página tiene cambios sin guardar: «Descartar» y
 * «Guardar» (todo lo cambiado de la página). Va al final del contenido con
 * `sticky`, así se queda en la parte de abajo de la pantalla mientras se baja,
 * y deja sitio para la barra de inicio del iPhone.
 */
export function UnsavedChangesBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  canSave = true,
  hint,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** false si algo no es válido (el motivo va en `hint`). */
  canSave?: boolean;
  hint?: string;
}) {
  if (!dirty && !saving) return null;
  return (
    <div
      className="sticky bottom-0 z-30 -mx-1 pb-safe"
      role="region"
      aria-label="Cambios sin guardar"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:mb-4 sm:px-4">
        <p className="mr-auto text-sm font-medium">
          Tienes cambios sin guardar
          {hint && <span className="block text-xs font-normal text-destructive">{hint}</span>}
        </p>
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
          Descartar
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving || !canSave}>
          {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
          Guardar
        </Button>
      </div>
    </div>
  );
}
