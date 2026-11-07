'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { InvoiceDto } from '@storageos/shared';

import {
  InvoiceLinesEditor,
  invoiceLinesFrom,
  invoiceLinesInput,
  invoiceLinesInvalid,
  invoiceLinesTotal,
} from '@/components/billing/invoice-lines-editor';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useUpdateInvoice } from '@/lib/billing/hooks';
import { formatEur } from '@/lib/format';

/** El motivo de una simplificada de más de 400 € va al principio de las notas. */
const F2_PREFIX = /^\[F2:[a-z_]+\]\s*/;

/** Cambiar las líneas, el vencimiento y las notas de un borrador. */
export function EditDraftDialog({
  invoice,
  onClose,
}: {
  invoice: InvoiceDto;
  onClose: () => void;
}) {
  const update = useUpdateInvoice();
  const f2Prefix = invoice.notes?.match(F2_PREFIX)?.[0] ?? '';
  const [items, setItems] = useState(() => invoiceLinesFrom(invoice.items));
  const [dueDate, setDueDate] = useState<string | undefined>(invoice.dueDate ?? undefined);
  const [notes, setNotes] = useState((invoice.notes ?? '').slice(f2Prefix.length));
  const total = invoiceLinesTotal(items);
  const f2Limit = invoice.invoiceType === 'F2' ? (f2Prefix ? 3000 : 400) : null;
  const overLimit = f2Limit !== null && total > f2Limit;

  async function save(): Promise<void> {
    try {
      await update.mutateAsync({
        id: invoice.id,
        input: {
          items: invoiceLinesInput(items),
          notes: `${f2Prefix}${notes.trim()}`.trim(),
          ...(dueDate && dueDate !== invoice.dueDate ? { dueDate } : {}),
        },
      });
      toast.success('Borrador guardado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar el borrador</DialogTitle>
          <DialogDescription>
            Aún no tiene número ni se ha enviado a nadie: puedes cambiarlo todo hasta emitirla.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <InvoiceLinesEditor items={items} onChange={setItems} catalog />
          {overLimit && (
            <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Una factura simplificada no puede pasar de {formatEur(f2Limit)}
              {f2Prefix ? '' : ' sin un motivo'}. Haz una factura completa.
            </p>
          )}
          <div className="space-y-1">
            <Label>Vencimiento</Label>
            <DateSelect value={dueDate} onChange={setDueDate} future />
            <p className="text-xs text-muted-foreground">
              {invoice.dueDate
                ? 'Si no lo cambias, se queda el que tiene.'
                : 'Sin fecha: al emitirla se pone el plazo de pago del negocio.'}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="draft-notes">Notas (salen en la factura)</Label>
            <Textarea
              id="draft-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 1900))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={update.isPending || invoiceLinesInvalid(items) || overLimit}
            onClick={() => void save()}
          >
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
