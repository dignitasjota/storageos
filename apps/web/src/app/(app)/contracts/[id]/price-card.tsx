'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { ContractDto, PriceHistoryEntryDto } from '@storageos/shared';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { formatDate, formatEur } from '@/lib/format';
import {
  usePriceHistory,
  useSetAnniversaryPct,
  useSetRentIncreaseExemption,
} from '@/lib/portfolio/hooks';

/**
 * La cuota del contrato a lo largo del tiempo (con los cambios ya previstos),
 * «no subir hasta…» y el porcentaje propio de la actualización anual.
 */
export function PriceCard({ contract: c }: { contract: ContractDto }) {
  const history = usePriceHistory(c.id);
  const canManage = useHasPermission('contracts:manage');
  const live = c.status === 'active' || c.status === 'ending';
  const entries = history.data?.entries ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Cuota</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {entries.length > 0 && <HistoryList entries={entries} />}
        {canManage && live && (
          <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
            <ExemptionForm contract={c} />
            <AnniversaryPctForm contract={c} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryList({ entries }: { entries: PriceHistoryEntryDto[] }) {
  return (
    <ol className="space-y-1.5">
      {entries.map((e, i) => (
        <li key={`${e.date}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-28 shrink-0 text-xs text-muted-foreground">{formatDate(e.date)}</span>
          <span className={e.kind === 'scheduled' ? 'text-primary' : ''}>
            {e.from != null ? (
              <>
                {formatEur(e.from)} → <strong>{formatEur(e.to)}</strong>
              </>
            ) : (
              <strong>{formatEur(e.to)}</strong>
            )}
          </span>
          {e.reason && <span className="text-xs text-muted-foreground">· {e.reason}</span>}
          {e.kind === 'scheduled' && (
            <span className="text-xs font-medium text-primary">· previsto</span>
          )}
        </li>
      ))}
      <li className="pt-1 text-xs text-muted-foreground">Importes sin IVA.</li>
    </ol>
  );
}

function ExemptionForm({ contract: c }: { contract: ContractDto }) {
  const set = useSetRentIncreaseExemption();
  const [until, setUntil] = useState(c.rentIncreaseExemptUntil ?? '');
  const [reason, setReason] = useState(c.rentIncreaseExemptReason ?? '');
  useEffect(() => {
    setUntil(c.rentIncreaseExemptUntil ?? '');
    setReason(c.rentIncreaseExemptReason ?? '');
  }, [c.rentIncreaseExemptUntil, c.rentIncreaseExemptReason]);

  async function save(clear = false) {
    try {
      await set.mutateAsync({
        contractId: c.id,
        input: clear || !until ? { until: null } : { until, reason: reason.trim() || undefined },
      });
      toast.success(clear || !until ? 'Ya entra en las subidas.' : 'Guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="space-y-2">
      <p className="font-medium">No subir hasta</p>
      <p className="text-xs text-muted-foreground">
        No entra en las subidas de precio ni en la actualización anual hasta esa fecha.
      </p>
      <DateSelect value={until || undefined} onChange={(v) => setUntil(v ?? '')} future years={3} />
      <Input
        aria-label="Motivo"
        placeholder="Motivo (opcional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void save()} disabled={set.isPending}>
          Guardar
        </Button>
        {c.rentIncreaseExemptUntil && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void save(true)}
            disabled={set.isPending}
          >
            Quitar
          </Button>
        )}
      </div>
    </div>
  );
}

function AnniversaryPctForm({ contract: c }: { contract: ContractDto }) {
  const set = useSetAnniversaryPct();
  const [pct, setPct] = useState(
    c.anniversaryUpdatePct != null ? String(c.anniversaryUpdatePct) : '',
  );
  useEffect(() => {
    setPct(c.anniversaryUpdatePct != null ? String(c.anniversaryUpdatePct) : '');
  }, [c.anniversaryUpdatePct]);

  async function save(clear = false) {
    const value = clear || !pct.trim() ? null : Number(pct.replace(',', '.'));
    if (value !== null && (Number.isNaN(value) || value < -20 || value > 30)) {
      toast.error('El porcentaje tiene que estar entre -20 y 30.');
      return;
    }
    try {
      await set.mutateAsync({ contractId: c.id, pct: value });
      toast.success(value === null ? 'Usará el porcentaje del negocio.' : 'Guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className="space-y-2">
      <p className="font-medium">Porcentaje de la actualización anual</p>
      <p className="text-xs text-muted-foreground">
        Si su contrato pacta otro índice. Vacío: el del negocio (Renovaciones).
      </p>
      <Input
        aria-label="Porcentaje"
        inputMode="decimal"
        placeholder="El del negocio"
        value={pct}
        onChange={(e) => setPct(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void save()} disabled={set.isPending}>
          Guardar
        </Button>
        {c.anniversaryUpdatePct != null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void save(true)}
            disabled={set.isPending}
          >
            Usar el del negocio
          </Button>
        )}
      </div>
    </div>
  );
}
