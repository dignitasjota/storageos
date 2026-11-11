import type { SepaRemittanceDto } from '@storageos/shared';

/** Estado de la remesa en palabras (una confirmada sin ningún cobro, «rechazada»). */
export function statusOf(r: SepaRemittanceDto): {
  label: string;
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
} {
  if (r.status === 'generated') return { label: 'Pendiente del banco', variant: 'secondary' };
  if (r.status === 'cancelled') return { label: 'Cancelada', variant: 'outline' };
  if (r.pendingCount > 0) return { label: 'Registro a medias', variant: 'secondary' };
  if (r.collectedCount === 0) return { label: 'Rechazada', variant: 'destructive' };
  return { label: 'Cobrada', variant: 'default' };
}
