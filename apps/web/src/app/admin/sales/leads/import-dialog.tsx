'use client';

import { type SalesImportResultDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { errorText } from '@/components/admin/sales/common';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useSalesImport } from '@/lib/admin/sales-hooks';
import { cn } from '@/lib/utils';

/** Lista de prospectos en CSV: revisa y, al confirmar, los añade a su cartera. */
export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const run = useSalesImport();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<SalesImportResultDto | null>(null);

  async function go(commit: boolean) {
    try {
      const res = await run.mutateAsync({ csv, commit });
      setResult(res);
      if (commit) {
        toast.success(`${res.created} prospectos añadidos a tu cartera.`);
        setCsv('');
        setResult(null);
        onClose();
      }
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido leer el fichero.'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setResult(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar prospectos</DialogTitle>
          <DialogDescription>
            Un CSV con columnas como empresa, contacto, email, teléfono, ciudad, trasteros, locales,
            programa y nota (separado por «;» o «,»). Los que ya son contacto de TrasterOS no se
            importan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void file.text().then((t) => {
                setCsv(t);
                setResult(null);
              });
            }}
          />
          <Textarea
            rows={6}
            className="font-mono text-xs"
            placeholder={
              'empresa;contacto;email;telefono;ciudad\nTrasteros Sol;Marta;marta@ejemplo.com;600111222;Málaga'
            }
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setResult(null);
            }}
          />
        </div>
        {result && (
          <div className="space-y-2">
            <p className="text-sm">
              {result.valid} para importar · {result.duplicates} ya existen · {result.errors} con
              errores
            </p>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Línea</TableHead>
                    <TableHead>Empresa / contacto</TableHead>
                    <TableHead>Email / teléfono</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((r) => (
                    <TableRow key={r.line}>
                      <TableCell className="tabular-nums">{r.line}</TableCell>
                      <TableCell>{r.companyName ?? r.contactName ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {r.email ?? ''} {r.phone ?? ''}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-xs',
                          r.error
                            ? 'text-destructive'
                            : r.duplicate
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-emerald-700 dark:text-emerald-400',
                        )}
                      >
                        {r.error ?? (r.duplicate ? 'Ya existe' : 'Se importará')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          {!result ? (
            <Button disabled={!csv.trim() || run.isPending} onClick={() => void go(false)}>
              {run.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Revisar
            </Button>
          ) : (
            <Button disabled={result.valid === 0 || run.isPending} onClick={() => void go(true)}>
              {run.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Importar {result.valid}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
