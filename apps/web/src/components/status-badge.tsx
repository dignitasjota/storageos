import type { UnitStatusValue } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';

const labels: Record<UnitStatusValue, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

const variants: Record<UnitStatusValue, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  available: 'outline',
  occupied: 'default',
  reserved: 'secondary',
  maintenance: 'secondary',
  blocked: 'destructive',
};

export function StatusBadge({ status }: { status: UnitStatusValue }) {
  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}
