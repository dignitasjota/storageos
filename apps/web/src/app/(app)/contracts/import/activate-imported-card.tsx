'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ActivateImportedContractsResultDto, ImportCommitDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useActivateImportedContracts } from '@/lib/customers/hooks';

/** Primer día del mes siguiente, `YYYY-MM-DD`. */
function firstOfNextMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
}

/**
 * Tras importar contratos (entran como borradores): activarlos todos de una
 * vez como contratos que ya estaban en vigor en el sistema anterior.
 */
export function ActivateImportedCard({ result }: { result: ImportCommitDto }) {
  const ids = result.rows.filter((r) => r.status === 'created' && r.id).map((r) => r.id as string);
  const activate = useActivateImportedContracts();
  const [billingStartsOn, setBillingStartsOn] = useState(firstOfNextMonth());
  const [depositCollected, setDepositCollected] = useState(true);
  const [done, setDone] = useState<ActivateImportedContractsResultDto | null>(null);

  if (ids.length === 0) return null;

  async function onActivate() {
    try {
      const r = await activate.mutateAsync({ contractIds: ids, billingStartsOn, depositCollected });
      setDone(r);
      if (r.failed.length === 0) toast.success(`${r.activated} contratos activados.`);
      else toast.warning(`${r.activated} activados, ${r.failed.length} con problemas.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron activar.');
    }
  }

  if (done) {
    return (
      <div className="space-y-2 rounded-md border p-3 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-4 text-emerald-600" />
          {done.activated} contratos activados
        </p>
        {done.failed.length > 0 && (
          <div className="max-h-40 overflow-auto text-xs text-destructive">
            {done.failed.map((f) => (
              <p key={f.contractId}>
                {f.contractNumber ?? f.contractId}: {f.error}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div>
        <p className="font-medium">¿Son contratos que ya estaban en vigor?</p>
        <p className="text-muted-foreground">
          Actívalos todos de una vez: quedan activos con su fecha de alta original y el trastero
          ocupado, sin firma ni avisos al inquilino. Los accesos se dan aparte, desde cada
          inquilino.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="billing-from">Empezar a facturar desde</Label>
          <Input
            id="billing-from"
            type="date"
            value={billingStartsOn}
            onChange={(e) => setBillingStartsOn(e.target.value)}
            className="text-base sm:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Lo anterior lo facturó tu sistema anterior y no se vuelve a cobrar.
          </p>
        </div>
        <label className="flex items-start gap-2 pt-6">
          <Checkbox
            checked={depositCollected}
            onCheckedChange={(v) => setDepositCollected(v === true)}
          />
          <span>
            Las fianzas ya están cobradas
            <span className="block text-xs text-muted-foreground">
              Quedan retenidas, sin emitir justificante ni cobrarlas de nuevo.
            </span>
          </span>
        </label>
      </div>
      <Button onClick={() => void onActivate()} disabled={activate.isPending || !billingStartsOn}>
        {activate.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
        Activar los {ids.length} contratos
      </Button>
    </div>
  );
}
