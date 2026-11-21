import type { UnitStatusValue } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';

const labels: Record<UnitStatusValue, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
  ceded: 'Cedido',
};

const variants: Record<UnitStatusValue, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  available: 'outline',
  occupied: 'default',
  reserved: 'secondary',
  maintenance: 'secondary',
  blocked: 'destructive',
  ceded: 'outline',
};

/** «Cedido» lleva su propio color (violeta), distinto de los demás estados. */
const CEDED_CLASS =
  'border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200';

export function StatusBadge({ status }: { status: UnitStatusValue }) {
  return (
    <Badge variant={variants[status]} className={status === 'ceded' ? CEDED_CLASS : undefined}>
      {labels[status]}
    </Badge>
  );
}
