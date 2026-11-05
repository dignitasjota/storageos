'use client';

import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CustomerDto } from '@storageos/shared';

import { CustomerSearchSelect } from '@/components/customer-search-select';
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
import { ApiError } from '@/lib/auth/api';
import { useMergeCustomer, useMergePreview } from '@/lib/customers/features-hooks';

/** Une otra ficha a esta: todo pasa aquí y la otra desaparece. No se puede deshacer. */
export function MergeCustomerDialog({
  customer,
  onClose,
}: {
  customer: CustomerDto;
  onClose: () => void;
}) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const preview = useMergePreview(customer.id, sourceId);
  const merge = useMergeCustomer(customer.id);
  const p = preview.data;

  async function submit() {
    if (!sourceId) return;
    try {
      await merge.mutateAsync(sourceId);
      toast.success('Fichas unidas.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo fusionar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="overflow-visible sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fusionar con otra ficha</DialogTitle>
          <DialogDescription>
            Se queda {customer.displayName}. Lo de la otra ficha pasa aquí y esa desaparece. No se
            puede deshacer.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Ficha que desaparece</Label>
            <CustomerSearchSelect
              value={sourceId ?? undefined}
              onChange={(v) => setSourceId(v ?? null)}
            />
          </div>
          {preview.isError && (
            <p className="text-sm text-destructive">
              {preview.error instanceof ApiError
                ? preview.error.body.message
                : 'No se ha podido comprobar.'}
            </p>
          )}
          {p && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                Pasarán a {p.target.displayName}:{' '}
                {p.moves
                  .filter((m) => m.count > 0)
                  .map((m) => `${m.count} ${m.label.toLowerCase()}`)
                  .join(', ') || 'solo sus datos'}
                .
              </p>
              {p.warnings.map((w) => (
                <p key={w} className="flex gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {w}
                </p>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!p || merge.isPending}
            onClick={() => void submit()}
          >
            Fusionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
