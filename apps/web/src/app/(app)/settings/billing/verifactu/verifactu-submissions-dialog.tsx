'use client';

import type { VerifactuSubmissionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useVerifactuSubmissionsQuery } from '@/lib/billing/verifactu-hooks';
import { formatDateTime } from '@/lib/format';

/** «todas registradas», «2 rechazadas», «sin respuesta: se repite»… */
export function submissionResultLabel(s: VerifactuSubmissionDto): string {
  if (s.status === 'error') return 'sin respuesta de la AEAT: se repite';
  if (s.status === 'rejected') return 'rechazado';
  if (s.rejectedCount > 0) {
    return s.rejectedCount === 1 ? '1 rechazada' : `${s.rejectedCount} rechazadas`;
  }
  return s.recordCount === 1 ? 'registrada' : 'todas registradas';
}

const BADGE: Record<VerifactuSubmissionDto['status'], { label: string; className: string }> = {
  accepted: {
    label: 'Correcto',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  partially_accepted: {
    label: 'Con rechazos',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  rejected: {
    label: 'Rechazado',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  error: {
    label: 'Sin respuesta',
    className: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  },
};

/**
 * Los últimos envíos a la AEAT: cuándo, cuántas facturas, qué pasó y el CSV
 * que acredita cada uno.
 */
export function VerifactuSubmissionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submissions = useVerifactuSubmissionsQuery(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Envíos a la AEAT</DialogTitle>
          <DialogDescription>
            Cada envío lleva las facturas emitidas desde el anterior. El CSV es el justificante que
            da la AEAT de lo que ha registrado.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto text-sm">
          {submissions.isLoading && <Skeleton className="h-24 w-full" />}
          {submissions.isError && (
            <p className="text-destructive">
              No se han podido cargar los envíos.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => void submissions.refetch()}
              >
                Reintentar
              </button>
            </p>
          )}
          {submissions.data?.length === 0 && (
            <p className="text-muted-foreground">Aún no se ha enviado nada.</p>
          )}
          {submissions.data?.map((s) => (
            <div key={s.id} className="space-y-1 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{formatDateTime(s.sentAt)}</span>
                <Badge variant="secondary" className={`shrink-0 ${BADGE[s.status].className}`}>
                  {BADGE[s.status].label}
                </Badge>
              </div>
              <p className="text-muted-foreground">
                {s.recordCount === 1 ? '1 factura' : `${s.recordCount} facturas`} ·{' '}
                {submissionResultLabel(s)}
                {s.ownerName ? ` · emite ${s.ownerName}` : ''}
              </p>
              {s.csv && (
                <p className="break-all">
                  CSV <span className="font-mono">{s.csv}</span>
                </p>
              )}
              {s.status === 'error' && s.message && (
                <p className="break-words text-muted-foreground">{s.message}</p>
              )}
              {s.mode === 'stub' && (
                <p className="text-xs text-muted-foreground">Simulado: no ha llegado a la AEAT.</p>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
