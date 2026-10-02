import type { InvoiceStatusValue } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';

const labels: Record<InvoiceStatusValue, string> = {
  draft: 'Borrador',
  issued: 'Emitida',
  paid: 'Pagada',
  overdue: 'Vencida',
  cancelled: 'Cancelada',
  refunded: 'Reembolsada',
  partially_refunded: 'Reemb. parcial',
  rectified: 'Anulada',
};

const variants: Record<InvoiceStatusValue, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'outline',
  issued: 'secondary',
  paid: 'default',
  overdue: 'destructive',
  cancelled: 'outline',
  refunded: 'outline',
  partially_refunded: 'secondary',
  rectified: 'outline',
};

/**
 * `total` opcional: una rectificativa de abono pagada (importe negativo) se
 * muestra como «Compensada» (se saldó con la factura que anula).
 */
export function InvoiceStatusBadge({
  status,
  total,
}: {
  status: InvoiceStatusValue;
  total?: number;
}) {
  const label =
    status === 'paid' && total !== undefined && total < 0 ? 'Compensada' : labels[status];
  return <Badge variant={variants[status]}>{label}</Badge>;
}
