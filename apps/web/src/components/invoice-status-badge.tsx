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
};

const variants: Record<InvoiceStatusValue, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'outline',
  issued: 'secondary',
  paid: 'default',
  overdue: 'destructive',
  cancelled: 'outline',
  refunded: 'outline',
  partially_refunded: 'secondary',
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatusValue }) {
  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}
