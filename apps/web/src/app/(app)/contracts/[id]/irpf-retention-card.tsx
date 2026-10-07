'use client';

import { Percent } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useSetIrpfRetention } from '@/lib/customers/hooks';

/**
 * Retención de IRPF: cuando el inquilino es una empresa o un profesional que
 * alquila para su actividad y el arrendador debe soportar retención.
 */
export function IrpfRetentionCard({ contract }: { contract: ContractDto }) {
  const canEdit = useHasPermission('contracts:manage');
  const save = useSetIrpfRetention(contract.id);
  const [pct, setPct] = useState(String(contract.irpfRetentionPct));
  useEffect(() => setPct(String(contract.irpfRetentionPct)), [contract.irpfRetentionPct]);

  if (!canEdit && contract.irpfRetentionPct === 0) return null;

  async function onSave() {
    const value = Number(pct.replace(',', '.'));
    if (Number.isNaN(value) || value < 0 || value > 50) {
      toast.error('Indica un porcentaje entre 0 y 50.');
      return;
    }
    try {
      await save.mutateAsync(value);
      toast.success(value > 0 ? 'Retención guardada.' : 'Sin retención.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Percent className="size-4" />
          Retención de IRPF
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Si el inquilino es una empresa o un profesional que debe retener (habitualmente el 19 %),
          las facturas que se emitan desde ahora restan la retención del total a pagar. El total de
          la factura y el IVA no cambian.
        </p>
        {canEdit ? (
          <div className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="irpf-pct">Porcentaje</Label>
              <Input
                id="irpf-pct"
                inputMode="decimal"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="w-28 text-base sm:text-sm"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void onSave()}
              disabled={
                save.isPending || Number(pct.replace(',', '.')) === contract.irpfRetentionPct
              }
            >
              Guardar
            </Button>
          </div>
        ) : (
          <p>{contract.irpfRetentionPct} %</p>
        )}
      </CardContent>
    </Card>
  );
}
