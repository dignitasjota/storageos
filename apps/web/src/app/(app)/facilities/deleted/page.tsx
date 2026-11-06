'use client';

import { FACILITY_RESTORE_DAYS, type DeletedFacilityDto } from '@storageos/shared';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useDeletedFacilities, useRestoreFacility } from '@/lib/facilities/hooks';
import { formatDate } from '@/lib/format';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** La papelera de locales: se pueden recuperar durante 30 días. */
export default function DeletedFacilitiesPage() {
  const canManage = useHasPermission('facilities:manage');
  const deleted = useDeletedFacilities();
  const restore = useRestoreFacility();
  const ask = useConfirm();

  async function onRestore(f: DeletedFacilityDto) {
    if (
      !(await ask({
        title: `¿Restaurar ${f.name}?`,
        description:
          'Vuelve con sus trasteros, su dirección en la web y lo que se apagó al borrarlo: planes de mantenimiento, gastos fijos, puertas y cámaras.',
        confirmLabel: 'Restaurar',
      }))
    ) {
      return;
    }
    try {
      await restore.mutateAsync(f.id);
      toast.success(`${f.name} restaurado.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo restaurar.');
    }
  }

  return (
    <div className="space-y-5 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/facilities">
            <ArrowLeft className="mr-1 h-4 w-4" /> Locales
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Locales borrados</h1>
        <p className="text-sm text-muted-foreground">
          Se pueden restaurar durante {FACILITY_RESTORE_DAYS} días.
        </p>
      </div>
      {deleted.isError ? (
        <SectionError onRetry={() => void deleted.refetch()} />
      ) : deleted.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (deleted.data ?? []).length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No hay locales borrados.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(deleted.data ?? []).map((f) => (
            <Card key={f.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{f.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[f.city, plural(f.unitsCount, 'trastero', 'trasteros')]
                      .filter(Boolean)
                      .join(' · ')}{' '}
                    · Borrado el {formatDate(f.deletedAt)} · Quedan{' '}
                    {plural(f.daysLeft, 'día', 'días')}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    disabled={restore.isPending}
                    onClick={() => void onRestore(f)}
                  >
                    Restaurar
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
