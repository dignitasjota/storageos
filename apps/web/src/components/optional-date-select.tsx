'use client';

import { X } from 'lucide-react';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';

/**
 * Fecha opcional (`YYYY-MM-DD` o vacío) con el selector del proyecto y un botón
 * para quitarla. El selector nativo del navegador no se abre en Safari.
 */
export function OptionalDateSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DateSelect value={value || undefined} onChange={(v) => onChange(v ?? '')} around />
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="Quitar la fecha"
          onClick={() => onChange('')}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
