'use client';

import type { VerifactuRecordDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useVerifactuRecordsQuery } from '@/lib/billing/verifactu-hooks';
import { formatDateTime } from '@/lib/format';

/** «Alta», «Subsanación tras un rechazo», «Anulación sin registro previo»… */
export function verifactuRecordLabel(r: VerifactuRecordDto): string {
  if (r.kind === 'anulacion') {
    if (r.sinRegistroPrevio) return 'Anulación (la AEAT no tenía la factura)';
    if (r.rechazoPrevio) return 'Anulación, tras rechazarse la anterior';
    return 'Anulación';
  }
  if (!r.subsanacion) return 'Alta';
  if (r.rechazoPrevio === 'X') return 'Subsanación, tras el rechazo del alta';
  if (r.rechazoPrevio === 'S') return 'Subsanación, tras rechazarse la anterior';
  return 'Subsanación';
}

const STATUS: Record<VerifactuRecordDto['status'], { label: string; className: string }> = {
  pending: {
    label: 'Por enviar',
    className: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  },
  accepted: {
    label: 'Aceptado',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  accepted_with_warnings: {
    label: 'Aceptado con avisos',
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
 * Los registros de Veri*Factu de la factura, en el orden de la cadena: su
 * alta y, si los hay, las subsanaciones y la anulación. Cada uno se guarda tal
 * como se generó; lo que dijo la AEAT de cada uno.
 */
export function VerifactuRecords({ invoiceId }: { invoiceId: string }) {
  const records = useVerifactuRecordsQuery(invoiceId);
  if (records.isLoading) return <Skeleton className="h-16 w-full" />;
  if (records.isError || !records.data || records.data.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Registros enviados a la AEAT</p>
      <ul className="space-y-2">
        {records.data.map((r) => {
          // En modo de pruebas lo «aceptado» no llegó a la AEAT.
          const simulated =
            r.simulated && (r.status === 'accepted' || r.status === 'accepted_with_warnings');
          const status = simulated
            ? { label: 'Simulado', className: STATUS.pending.className }
            : STATUS[r.status];
          return (
            <li key={r.id} className="space-y-1 rounded-md border p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{verifactuRecordLabel(r)}</span>
                <Badge variant="secondary" className={`shrink-0 ${status.className}`}>
                  {status.label}
                </Badge>
              </div>
              <p className="text-muted-foreground">
                Generado el {formatDateTime(r.createdAt)}
                {r.sentAt && ` · enviado el ${formatDateTime(r.sentAt)}`}
                {r.incident && ' · enviado tarde por una incidencia'}
              </p>
              {r.csv && !r.simulated && (
                <p className="break-all">
                  CSV <span className="font-mono">{r.csv}</span>
                </p>
              )}
              {r.reason && <p>Motivo: {r.reason}</p>}
              {r.message &&
                (r.status === 'rejected' ||
                  r.status === 'accepted_with_warnings' ||
                  r.status === 'error') && (
                  <p className="break-words text-muted-foreground">AEAT: {r.message}</p>
                )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
