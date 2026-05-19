import type { ContractStatusValue } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';

const labels: Record<ContractStatusValue, string> = {
  draft: 'Borrador',
  active: 'Activo',
  ending: 'En baja',
  ended: 'Finalizado',
  cancelled: 'Cancelado',
};

const variants: Record<ContractStatusValue, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'outline',
  active: 'default',
  ending: 'secondary',
  ended: 'outline',
  cancelled: 'destructive',
};

export function ContractStatusBadge({ status }: { status: ContractStatusValue }) {
  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}
