'use client';

import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { downloadCsv } from '@/lib/csv';

/** Botón «CSV» de una tarjeta: descarga lo que enseña. */
export function CsvButton({
  filename,
  rows,
  disabled,
}: {
  filename: string;
  rows: () => (string | number)[][];
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={disabled}
      onClick={() => downloadCsv(filename, rows())}
      aria-label={`Descargar ${filename}`}
    >
      <Download className="mr-1 size-3.5" /> CSV
    </Button>
  );
}
