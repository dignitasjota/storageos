'use client';

import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateFloor, useDeleteFloor, useFloors, useUpdateFloor } from '@/lib/facilities/hooks';

const PlanEditor = dynamic(() => import('./plan-editor').then((m) => m.PlanEditor), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  ),
});

interface Props {
  facilityId: string;
}

type Editing = { mode: 'new' } | { mode: 'edit'; id: string; name: string; floorNumber: number };

export function FacilityFloorsTab({ facilityId }: Props) {
  const ask = useConfirm();
  const floors = useFloors(facilityId);
  const canManage = useHasPermission('facilities:manage');
  const create = useCreateFloor();
  const update = useUpdateFloor();
  const remove = useDeleteFloor();
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState('');
  const [floorNumber, setFloorNumber] = useState('0');

  if (floors.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const allFloors = floors.data ?? [];
  const current = allFloors.find((f) => f.id === selectedFloorId) ?? allFloors[0] ?? null;

  function openNew() {
    setName('');
    setFloorNumber(String(allFloors.length));
    setEditing({ mode: 'new' });
  }

  async function save() {
    const n = Number.parseInt(floorNumber, 10);
    if (!name.trim() || !Number.isInteger(n) || n < -10 || n > 50) {
      toast.error('Pon un nombre y un número de planta entre -10 y 50.');
      return;
    }
    try {
      if (editing?.mode === 'edit') {
        await update.mutateAsync({ id: editing.id, input: { name: name.trim(), floorNumber: n } });
        toast.success('Planta guardada.');
      } else {
        const floor = await create.mutateAsync({
          facilityId,
          input: { name: name.trim(), floorNumber: n },
        });
        setSelectedFloorId(floor.id);
        toast.success('Planta creada.');
      }
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onDelete() {
    if (!current) return;
    if (!(await ask({ title: `¿Borrar la planta «${current.name}»?`, destructive: true }))) return;
    try {
      await remove.mutateAsync(current.id);
      setSelectedFloorId(null);
      toast.success('Planta borrada.');
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string }).code : undefined;
      toast.error(
        code === 'floor_has_units'
          ? 'Tiene trasteros: muévelos a otra planta (editando cada trastero) antes de borrarla.'
          : code === 'floor_is_default'
            ? 'Es la planta principal del local: no se puede borrar.'
            : err instanceof ApiError
              ? err.body.message
              : 'No se pudo borrar.',
      );
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {allFloors.length > 0 && (
          <>
            <span className="text-sm text-muted-foreground">Planta:</span>
            <Select value={current?.id ?? undefined} onValueChange={(v) => setSelectedFloorId(v)}>
              <SelectTrigger className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allFloors.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name} {f.isDefault && '(principal)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={openNew}>
              <Plus className="mr-1 h-4 w-4" /> Nueva planta
            </Button>
            {current && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setName(current.name);
                    setFloorNumber(String(current.floorNumber));
                    setEditing({
                      mode: 'edit',
                      id: current.id,
                      name: current.name,
                      floorNumber: current.floorNumber,
                    });
                  }}
                >
                  <Pencil className="mr-1 h-4 w-4" /> Renombrar
                </Button>
                {!current.isDefault && (
                  <Button size="sm" variant="ghost" onClick={() => void onDelete()}>
                    <Trash2 className="mr-1 h-4 w-4" /> Borrar
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {allFloors.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
          Este local aún no tiene plantas. Crea una para subir su plano (se crea sola una «Planta
          principal» con el primer trastero).
        </div>
      ) : (
        current && <PlanEditor facilityId={facilityId} floorId={current.id} />
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing?.mode === 'edit' ? 'Renombrar planta' : 'Nueva planta'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="floor-name">Nombre</Label>
              <Input
                id="floor-name"
                value={name}
                placeholder="Planta baja, Sótano, Altillo…"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="floor-number">Número (para ordenarlas; -1 = sótano)</Label>
              <Input
                id="floor-number"
                type="number"
                value={floorNumber}
                onChange={(e) => setFloorNumber(e.target.value)}
                className="w-28"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={create.isPending || update.isPending}>
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
