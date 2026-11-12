'use client';

import { FileUp, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import type { SepaBankResponseResultDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { useImportSepaBankResponse } from '@/lib/sepa/hooks';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Sube la respuesta del banco a una remesa (fichero pain.002): los adeudos que
 * rechazó quedan fallidos y los que devolvió tras cobrarse dejan de contar,
 * con su código.
 */
export function BankResponseButton({ size = 'default' }: { size?: 'default' | 'sm' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        <FileUp className="mr-1 h-4 w-4" /> Subir respuesta del banco
      </Button>
      {open && <BankResponseDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function BankResponseDialog({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useImportSepaBankResponse();
  const [result, setResult] = useState<SepaBankResponseResultDto | null>(null);

  async function onFile(file: File) {
    if (file.size > 5_000_000) {
      toast.error('El fichero es demasiado grande (máximo 5 MB).');
      return;
    }
    try {
      const content = await file.text();
      setResult(await upload.mutateAsync({ filename: file.name, content }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido leer el fichero.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Respuesta del banco</DialogTitle>
          <DialogDescription>
            Sube el fichero de respuesta a la remesa (pain.002, en XML) que da tu banca online: los
            adeudos rechazados quedan pendientes de cobro y los devueltos dejan de contar, con su
            motivo. Las devoluciones también entran por la conciliación del extracto (Norma 43).
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-2 text-sm">
            {result.remittanceName && (
              <p>
                Remesa{' '}
                <Link
                  href={`/sepa-remittances/${result.remittanceId}`}
                  className="font-medium underline-offset-2 hover:underline"
                  onClick={onClose}
                >
                  {result.remittanceName}
                </Link>
                :
              </p>
            )}
            <ul className="list-inside list-disc space-y-1">
              <li>{plural(result.rejected, 'rechazado', 'rechazados')} antes del cargo</li>
              <li>{plural(result.returned, 'devuelto', 'devueltos')} tras cobrarse</li>
              <li>{plural(result.accepted, 'aceptado', 'aceptados')} por el banco</li>
              {result.alreadyProcessed > 0 && (
                <li className="text-muted-foreground">
                  {plural(
                    result.alreadyProcessed,
                    'ya estaba registrado',
                    'ya estaban registrados',
                  )}
                </li>
              )}
            </ul>
            {result.unmatched.length > 0 && (
              <p className="text-amber-700 dark:text-amber-300">
                {plural(result.unmatched.length, 'referencia no es', 'referencias no son')} de
                ningún adeudo de tus remesas: {result.unmatched.slice(0, 5).join(', ')}
                {result.unmatched.length > 5 ? '…' : ''}
              </p>
            )}
          </div>
        ) : (
          <div className="flex justify-center py-4">
            <input
              ref={input}
              type="file"
              accept=".xml,text/xml,application/xml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = '';
              }}
            />
            <Button onClick={() => input.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="mr-1.5 h-4 w-4" />
              )}
              Elegir el fichero
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
