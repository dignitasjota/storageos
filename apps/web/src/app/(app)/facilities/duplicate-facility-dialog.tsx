'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { FacilityDto } from '@storageos/shared';

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
import { ApiError } from '@/lib/auth/api';
import { useDuplicateFacility } from '@/lib/facilities/hooks';

/** Otro local con la misma forma de trabajar. */
export function DuplicateFacilityDialog({
  facility,
  onClose,
}: {
  facility: FacilityDto | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const duplicate = useDuplicateFacility();
  const [name, setName] = useState('');
  useEffect(() => setName(facility ? `${facility.name} (copia)` : ''), [facility]);

  async function submit() {
    if (!facility) return;
    try {
      const created = await duplicate.mutateAsync({ id: facility.id, name: name.trim() });
      toast.success('Local creado. Completa su dirección y sus fotos en la ficha.');
      onClose();
      router.push(`/facilities/${created.id}?tab=settings`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo duplicar.');
    }
  }

  return (
    <Dialog open={!!facility} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicar {facility?.name}</DialogTitle>
          <DialogDescription>
            Se copian el horario, el toque de queda, las características, el contacto, el
            propietario y las plantas. La dirección, las fotos, los planos y los trasteros no: son
            de cada local.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="duplicate-name">Nombre del local nuevo</Label>
          <Input
            id="duplicate-name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={duplicate.isPending || name.trim().length < 2}
          >
            {duplicate.isPending ? 'Duplicando...' : 'Duplicar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
