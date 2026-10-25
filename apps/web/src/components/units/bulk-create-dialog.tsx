'use client';

import { bulkUnitCodes } from '@storageos/shared';
import { Rows3 } from 'lucide-react';
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
  DialogTrigger,
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
import { ApiError } from '@/lib/auth/api';
import { useFacilities, useFloors, useUnitTypes } from '@/lib/facilities/hooks';
import { useBulkCreateUnits } from '@/lib/facilities/inventory-hooks';

/** Alta de varios trasteros seguidos: «A-01» … «A-20» con las mismas medidas. */
export function BulkCreateUnitsDialog({ facilityId: fixedFacility }: { facilityId?: string }) {
  const [open, setOpen] = useState(false);
  const facilities = useFacilities();
  const types = useUnitTypes();
  const create = useBulkCreateUnits();
  const [f, setF] = useState({
    facilityId: fixedFacility ?? '',
    floorId: '',
    unitTypeId: '',
    prefix: 'A-',
    start: '1',
    count: '10',
    padding: '2',
    widthM: '2',
    depthM: '2',
    heightM: '2.5',
    price: '',
  });
  const facilityId = fixedFacility ?? f.facilityId;
  const floors = useFloors(open && facilityId ? facilityId : undefined);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const num = (v: string) => Number(v.replace(',', '.'));
  const count = Math.min(200, Math.max(0, Math.floor(num(f.count)) || 0));
  const preview =
    count > 0
      ? bulkUnitCodes({
          prefix: f.prefix,
          start: Math.max(0, Math.floor(num(f.start)) || 0),
          count,
          padding: Math.min(6, Math.max(0, Math.floor(num(f.padding)) || 0)),
        })
      : [];

  async function submit() {
    if (!facilityId || !f.unitTypeId) {
      toast.error('Elige el local y el tipo.');
      return;
    }
    if (!(num(f.widthM) > 0 && num(f.depthM) > 0 && num(f.heightM) > 0) || count < 1) {
      toast.error('Revisa las medidas y cuántos trasteros crear.');
      return;
    }
    try {
      const res = await create.mutateAsync({
        facilityId,
        ...(f.floorId ? { floorId: f.floorId } : {}),
        unitTypeId: f.unitTypeId,
        prefix: f.prefix.trim(),
        start: Math.floor(num(f.start)) || 0,
        count,
        padding: Math.floor(num(f.padding)) || 0,
        widthM: num(f.widthM),
        depthM: num(f.depthM),
        heightM: num(f.heightM),
        ...(f.price.trim() ? { basePriceMonthly: num(f.price) } : {}),
      });
      toast.success(
        `${res.created} trastero(s) creado(s)${res.skipped.length ? `; ya existían: ${res.skipped.join(', ')}` : ''}.`,
      );
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron crear.');
    }
  }

  const activeTypes = (types.data ?? []).filter((t) => t.isActive);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Rows3 className="mr-1 h-4 w-4" /> Crear varios
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Crear varios trasteros</DialogTitle>
          <DialogDescription>
            Con el mismo tipo y medidas y códigos seguidos. Los que ya existan se saltan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!fixedFacility && (
            <div className="space-y-1">
              <Label>Local</Label>
              <Select
                value={f.facilityId}
                onValueChange={(v) => setF((x) => ({ ...x, facilityId: v, floorId: '' }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona un local" />
                </SelectTrigger>
                <SelectContent>
                  {(facilities.data ?? []).map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select value={f.unitTypeId} onValueChange={(v) => set('unitTypeId', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Tipo" />
                </SelectTrigger>
                <SelectContent>
                  {activeTypes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(floors.data ?? []).length > 1 && (
              <div className="space-y-1">
                <Label>Planta</Label>
                <Select value={f.floorId} onValueChange={(v) => set('floorId', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Principal" />
                  </SelectTrigger>
                  <SelectContent>
                    {(floors.data ?? []).map((fl) => (
                      <SelectItem key={fl.id} value={fl.id}>
                        {fl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Small label="Prefijo" value={f.prefix} onChange={(v) => set('prefix', v)} />
            <Small label="Desde" value={f.start} onChange={(v) => set('start', v)} />
            <Small label="Cuántos" value={f.count} onChange={(v) => set('count', v)} />
            <Small label="Cifras" value={f.padding} onChange={(v) => set('padding', v)} />
          </div>
          {preview.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.length <= 4
                ? preview.join(', ')
                : `${preview[0]}, ${preview[1]} … ${preview[preview.length - 1]}`}{' '}
              ({preview.length})
            </p>
          )}
          <div className="grid grid-cols-4 gap-2">
            <Small label="Ancho (m)" value={f.widthM} onChange={(v) => set('widthM', v)} />
            <Small label="Fondo (m)" value={f.depthM} onChange={(v) => set('depthM', v)} />
            <Small label="Alto (m)" value={f.heightM} onChange={(v) => set('heightM', v)} />
            <Small
              label="Precio (€)"
              value={f.price}
              onChange={(v) => set('price', v)}
              placeholder="Del tipo"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending ? 'Creando…' : `Crear ${preview.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Small({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
