import type { ReservationStatusValue } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';

const labels: Record<ReservationStatusValue, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  expired: 'Caducada',
  converted: 'Convertida',
  cancelled: 'Cancelada',
};

const variants: Record<
  ReservationStatusValue,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  pending: 'outline',
  confirmed: 'default',
  expired: 'outline',
  converted: 'secondary',
  cancelled: 'destructive',
};

export function ReservationStatusBadge({ status }: { status: ReservationStatusValue }) {
  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}
