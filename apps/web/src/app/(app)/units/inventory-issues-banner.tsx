'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useChangeUnitStatus } from '@/lib/facilities/hooks';
import { inventoryIssuesKey, useInventoryIssues } from '@/lib/inventory/hooks';

const STATUS_LABELS: Record<string, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

/**
 * Aviso de trasteros en estado inconsistente (ocupado sin contrato, etc.) con la
 * opción de corregir el estado de un clic. Solo se muestra si hay descuadres.
 */
export function InventoryIssuesBanner() {
  const canManage = useHasPermission('units:write');
  const { data } = useInventoryIssues();
  const change = useChangeUnitStatus();
  const qc = useQueryClient();

  const issues = data ?? [];
  if (issues.length === 0) return null;

  async function fix(unitId: string, expected: string) {
    try {
      await change.mutateAsync({
        id: unitId,
        input: { status: expected as never, reason: 'Reconciliación de inventario' },
      });
      toast.success('Estado corregido.');
      void qc.invalidateQueries({ queryKey: inventoryIssuesKey });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo corregir.');
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangle className="size-4" />
        {issues.length} trastero(s) con estado inconsistente
      </p>
      <ul className="mt-2 space-y-1.5">
        {issues.map((i) => (
          <li
            key={i.unitId}
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-amber-900 dark:text-amber-200"
          >
            <span>
              <strong>{i.code}</strong> ({i.facilityName}) · {i.reason} · debería estar{' '}
              <strong>{STATUS_LABELS[i.expectedStatus] ?? i.expectedStatus}</strong>
            </span>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={change.isPending}
                onClick={() => fix(i.unitId, i.expectedStatus)}
              >
                Corregir a {STATUS_LABELS[i.expectedStatus] ?? i.expectedStatus}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
