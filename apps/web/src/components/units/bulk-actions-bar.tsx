'use client';

import { type UnitStatusValue } from '@storageos/shared';
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

type Action = 'status' | 'type' | 'floor' | 'price';

const ACTION_LABELS: Record<Action, string> = {
  status: 'Cambiar estado',
  type: 'Cambiar tipo',
  floor: 'Mover de planta',
  price: 'Cambiar precio',
};

/** Barra de acciones sobre los trasteros seleccionados. */
export function BulkUnitsBar({
  unitIds,
  facilityId,
  onDone,
}: {
  unitIds: string[];
  /** Mover de planta solo con un local elegido. */
  facilityId?: string;
  onDone: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [status, setStatus] = useState<UnitStatusValue>('available');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [floorId, setFloorId] = useState('');
  const [mode, setMode] = useState<'set' | 'percent'>('percent');
  const [value, setValue] = useState('');
  const types = useUnitTypes();
  const floors = useFloors(action === 'floor' ? facilityId : undefined);
  const bulk = useBulkUnits();
  if (unitIds.length === 0) return null;

  async function apply() {
    if (!action) return;
    const v = Number(value.replace(',', '.'));
    if (action === 'price' && !Number.isFinite(v)) {
      toast.error('Indica el precio o el porcentaje.');
      return;
    }
    if ((action === 'type' && !unitTypeId) || (action === 'floor' && !floorId)) {
      toast.error('Elige a qué cambiarlos.');
      return;
    }
    try {
      const res = await bulk.mutateAsync(
        action === 'status'
          ? { action, unitIds, status }
          : action === 'type'
            ? { action, unitIds, unitTypeId }
            : action === 'floor'
              ? { action, unitIds, floorId }
              : { action, unitIds, mode, value: v },
      );
      if (res.failed.length === 0) toast.success(`${res.updated} trastero(s) actualizado(s).`);
      else
        toast.warning(
          `${res.updated} actualizado(s); ${res.failed.length} no: ${res.failed[0]!.error}`,
        );
      setAction(null);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo aplicar.');
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm">
        <span className="font-medium">{unitIds.length} seleccionado(s)</span>
        {(Object.keys(ACTION_LABELS) as Action[])
          .filter((a) => a !== 'floor' || !!facilityId)
          .map((a) => (
            <Button key={a} size="sm" variant="outline" onClick={() => setAction(a)}>
              {ACTION_LABELS[a]}
            </Button>
          ))}
        <Button size="sm" variant="ghost" onClick={onDone}>
          Quitar selección
        </Button>
      </div>
      <Dialog open={!!action} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action ? ACTION_LABELS[action] : ''}</DialogTitle>
            <DialogDescription>
              {unitIds.length} trastero(s). Cada uno sigue sus reglas: los que no se puedan cambiar
              se indican al terminar.
            </DialogDescription>
          </DialogHeader>
          {action === 'status' && (
            <Select value={status} onValueChange={(v) => setStatus(v as UnitStatusValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['available', 'reserved', 'maintenance', 'blocked'] as UnitStatusValue[]).map(
                  (s) => (
                    <SelectItem key={s} value={s}>
                      {UNIT_STATUS_LABELS[s]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
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
            <div className="space-y-2">
              <Select value={mode} onValueChange={(v) => setMode(v as 'set' | 'percent')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Subir o bajar un %</SelectItem>
                  <SelectItem value="set">Fijar un precio (€, sin IVA)</SelectItem>
                </SelectContent>
              </Select>
              <Label htmlFor="bulk-value">
                {mode === 'percent' ? '% (negativo para bajar)' : '€ al mes'}
              </Label>
              <Input id="bulk-value" value={value} onChange={(e) => setValue(e.target.value)} />
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
    </>
  );
}
