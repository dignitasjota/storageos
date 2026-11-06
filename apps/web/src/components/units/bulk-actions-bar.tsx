'use client';

import {
  bulkUnitPrice,
  type BulkUnitsResultDto,
  UNIT_PRICE_ROUND_LABELS,
  type UnitPriceRound,
  type UnitStatusValue,
} from '@storageos/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UNIT_STATUS_LABELS } from '@/components/units/change-status-dialog';
import { ApiError } from '@/lib/auth/api';
import { useFloors, useUnitTypes } from '@/lib/facilities/hooks';
import { useBulkUnits } from '@/lib/facilities/inventory-hooks';
import { formatEur } from '@/lib/format';

type Action = 'status' | 'type' | 'floor' | 'price';

const ACTION_LABELS: Record<Action, string> = {
  status: 'Cambiar estado',
  type: 'Cambiar tipo',
  floor: 'Mover de planta',
  price: 'Cambiar precio',
};

export const UNIT_LABELS_KEY = 'storageos.units.labels';

/** Barra de acciones sobre los trasteros seleccionados. */
export function BulkUnitsBar({
  units,
  facilityId,
  onDone,
}: {
  units: { id: string; code: string; basePriceMonthly: number }[];
  /** Mover de planta solo con un local elegido. */
  facilityId?: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action | null>(null);
  const [status, setStatus] = useState<UnitStatusValue>('available');
  const [reason, setReason] = useState('');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [floorId, setFloorId] = useState('');
  const [mode, setMode] = useState<'set' | 'percent'>('percent');
  const [round, setRound] = useState<UnitPriceRound>('none');
  const [value, setValue] = useState('');
  const [result, setResult] = useState<BulkUnitsResultDto | null>(null);
  const types = useUnitTypes();
  const floors = useFloors(action === 'floor' ? facilityId : undefined);
  const bulk = useBulkUnits();
  if (units.length === 0) return null;

  const unitIds = units.map((u) => u.id);
  const amount = Number(value.replace(',', '.'));
  // Un campo vacío se lee como 0 y pondría gratis lo seleccionado.
  const priceReady = value.trim() !== '' && Number.isFinite(amount) && amount !== 0;
  const preview = priceReady
    ? units.map((u) => ({
        ...u,
        next: bulkUnitPrice(u.basePriceMonthly, { mode, value: amount, round }),
      }))
    : [];
  const monthlyChange = preview.reduce((sum, u) => sum + u.next - u.basePriceMonthly, 0);

  async function apply() {
    if (!action) return;
    if (action === 'price' && !priceReady) {
      toast.error('Indica el precio o el porcentaje.');
      return;
    }
    if ((action === 'type' && !unitTypeId) || (action === 'floor' && !floorId)) {
      toast.error('Elige a qué cambiarlos.');
      return;
    }
    if (action === 'status' && status !== 'available' && !reason.trim()) {
      toast.error('Di por qué se paran: sale en la ficha y en la lista.');
      return;
    }
    try {
      const res = await bulk.mutateAsync(
        action === 'status'
          ? { action, unitIds, status, ...(reason.trim() ? { reason: reason.trim() } : {}) }
          : action === 'type'
            ? { action, unitIds, unitTypeId }
            : action === 'floor'
              ? { action, unitIds, floorId }
              : { action, unitIds, mode, value: amount, round },
      );
      setAction(null);
      if (res.failed.length === 0) {
        toast.success(`${res.updated} trastero(s) actualizado(s).`);
        onDone();
      } else {
        setResult(res);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo aplicar.');
    }
  }

  function openLabels() {
    try {
      sessionStorage.setItem(UNIT_LABELS_KEY, JSON.stringify(unitIds));
    } catch {
      /* sin almacenamiento */
    }
    router.push('/units/labels');
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm">
        <span className="font-medium">{units.length} seleccionado(s)</span>
        {(Object.keys(ACTION_LABELS) as Action[])
          .filter((a) => a !== 'floor' || !!facilityId)
          .map((a) => (
            <Button key={a} size="sm" variant="outline" onClick={() => setAction(a)}>
              {ACTION_LABELS[a]}
            </Button>
          ))}
        <Button size="sm" variant="outline" onClick={openLabels}>
          Etiquetas
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Quitar selección
        </Button>
      </div>
      <Dialog open={!!action} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action ? ACTION_LABELS[action] : ''}</DialogTitle>
            <DialogDescription>
              {units.length} trastero(s). Cada uno sigue sus reglas: los que no se puedan cambiar se
              indican al terminar.
            </DialogDescription>
          </DialogHeader>
          {action === 'status' && (
            <div className="space-y-2">
              <Select value={status} onValueChange={(v) => setStatus(v as UnitStatusValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['available', 'maintenance', 'blocked'] as UnitStatusValue[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {UNIT_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {status !== 'available' && (
                <>
                  <Label htmlFor="bulk-reason">Motivo</Label>
                  <Input
                    id="bulk-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </>
              )}
            </div>
          )}
          {action === 'type' && (
            <Select value={unitTypeId} onValueChange={setUnitTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                {(types.data ?? [])
                  .filter((t) => t.isActive)
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
          {action === 'floor' && (
            <Select value={floorId} onValueChange={setFloorId}>
              <SelectTrigger>
                <SelectValue placeholder="Planta" />
              </SelectTrigger>
              <SelectContent>
                {(floors.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {action === 'price' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Select value={mode} onValueChange={(v) => setMode(v as 'set' | 'percent')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percent">Subir o bajar un %</SelectItem>
                    <SelectItem value="set">Fijar un precio (€, sin IVA)</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={round} onValueChange={(v) => setRound(v as UnitPriceRound)}>
                  <SelectTrigger aria-label="Redondeo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(UNIT_PRICE_ROUND_LABELS) as UnitPriceRound[]).map((r) => (
                      <SelectItem key={r} value={r}>
                        {UNIT_PRICE_ROUND_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="bulk-value">
                  {mode === 'percent' ? '% (negativo para bajar)' : '€ al mes'}
                </Label>
                <Input id="bulk-value" value={value} onChange={(e) => setValue(e.target.value)} />
              </div>
              {preview.length > 0 && (
                <div className="space-y-1 rounded-md border p-2 text-sm">
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                    {preview.map((u) => (
                      <li key={u.id} className="flex justify-between gap-2">
                        <span>{u.code}</span>
                        <span className="tabular-nums">
                          {formatEur(u.basePriceMonthly)} → <strong>{formatEur(u.next)}</strong>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="border-t pt-1 text-xs text-muted-foreground">
                    Si se alquilaran todos: {monthlyChange >= 0 ? '+' : '−'}
                    {formatEur(Math.abs(monthlyChange))} al mes.
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Es el precio de catálogo (próximos contratos); la cuota de los inquilinos actuales
                no cambia.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void apply()} disabled={bulk.isPending}>
              Aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!result}
        onOpenChange={(o) => {
          if (!o) {
            setResult(null);
            onDone();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {result?.updated ?? 0} actualizado(s), {result?.failed.length ?? 0} sin cambiar
            </DialogTitle>
            <DialogDescription>Estos trasteros no se han podido cambiar:</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {(result?.failed ?? []).map((f) => (
              <li key={f.unitId} className="border-b pb-1 last:border-0">
                <strong>{f.unitCode ?? '—'}</strong>
                <span className="block text-muted-foreground">{f.error}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              onClick={() => {
                setResult(null);
                onDone();
              }}
            >
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
