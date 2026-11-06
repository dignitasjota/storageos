'use client';

import { FACILITY_RESTORE_DAYS, type FacilityDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { useDeleteFacility, useFacilityDeletePreview } from '@/lib/facilities/hooks';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Borrar un local: primero lo que hay que resolver y lo que se va a apagar. */
export function DeleteFacilityDialog({
  facility,
  onClose,
}: {
  facility: FacilityDto | null;
  onClose: () => void;
}) {
  const preview = useFacilityDeletePreview(facility?.id ?? null);
  const remove = useDeleteFacility();
  const data = preview.data;
  const blocked = (data?.blockers.length ?? 0) > 0;

  const turnsOff = data
    ? [
        data.turnsOff.maintenancePlans > 0 &&
          plural(
            data.turnsOff.maintenancePlans,
            'plan de mantenimiento',
            'planes de mantenimiento',
          ),
        data.turnsOff.recurringExpenses > 0 &&
          plural(data.turnsOff.recurringExpenses, 'gasto recurrente', 'gastos recurrentes'),
        data.turnsOff.accessDevices > 0 &&
          plural(data.turnsOff.accessDevices, 'puerta o lector', 'puertas y lectores'),
        data.turnsOff.cameraDevices > 0 && plural(data.turnsOff.cameraDevices, 'cámara', 'cámaras'),
      ].filter((text): text is string => typeof text === 'string')
    : [];

  async function confirm() {
    if (!facility) return;
    try {
      await remove.mutateAsync(facility.id);
      toast.success('Local borrado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar.');
      void preview.refetch();
    }
  }

  return (
    <Dialog open={!!facility} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {blocked
              ? `Aún no se puede borrar «${facility?.name}»`
              : `¿Borrar «${facility?.name}»?`}
          </DialogTitle>
          <DialogDescription>
            {blocked
              ? 'Resuelve esto primero. Si solo quieres dejar de alquilarlo, desactívalo en sus ajustes.'
              : 'Sus trasteros dejan de salir en el panel, en tu web y en la reserva online. Su historial de contratos y facturas se conserva.'}
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {preview.isError && <SectionError onRetry={() => void preview.refetch()} />}

        {data && blocked && (
          <ul className="divide-y rounded-md border text-sm">
            {data.blockers.map((b) => (
              <li key={b.kind} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>{b.label}</span>
                <Link href={b.href} className="shrink-0 text-primary hover:underline">
                  Ver
                </Link>
              </li>
            ))}
          </ul>
        )}

        {data && !blocked && (
          <div className="space-y-3 text-sm">
            {data.unitsCount > 0 && (
              <p>Tiene {plural(data.unitsCount, 'trastero', 'trasteros')}.</p>
            )}
            {turnsOff.length > 0 && (
              <div>
                <p className="font-medium">Se apagará:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {turnsOff.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.usersLeftWithoutFacilities.length > 0 && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950">
                {data.usersLeftWithoutFacilities.join(', ')}{' '}
                {data.usersLeftWithoutFacilities.length === 1 ? 'solo ve' : 'solo ven'} este local:
                no verá ninguno hasta que le asignes otro en Configuración → Usuarios.
              </p>
            )}
            <p className="text-muted-foreground">
              Podrás restaurarlo durante {FACILITY_RESTORE_DAYS} días desde Locales → Borrados.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {blocked ? 'Cerrar' : 'Cancelar'}
          </Button>
          {data && !blocked && (
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => void confirm()}
            >
              {remove.isPending ? 'Borrando…' : 'Borrar el local'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
