'use client';

import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { ApiError } from '@/lib/auth/api';
import { useDeleteUnit } from '@/lib/facilities/hooks';

/** Borrar un trastero: confirma y, si no se puede, dice por qué. */
export function useDeleteUnitAction() {
  const ask = useConfirm();
  const remove = useDeleteUnit();
  return async (unit: { id: string; code: string }): Promise<boolean> => {
    const ok = await ask({ title: `¿Borrar el trastero ${unit.code}?`, destructive: true });
    if (!ok) return false;
    try {
      await remove.mutateAsync(unit.id);
      toast.success('Trastero borrado.');
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar.');
      return false;
    }
  };
}
