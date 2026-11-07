import type { InvoiceDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/format';

/**
 * Cómo va el cobro de una factura pendiente: en curso, en remesa, en plan de
 * pagos, recordada o con recargo. Nada si no aplica.
 */
export function InvoiceCollectionBadges({
  invoice,
  compact = false,
}: {
  invoice: Pick<InvoiceDto, 'status' | 'collection' | 'lateFeeInvoiceId'>;
  /** En la lista: sin la fecha del recordatorio. */
  compact?: boolean;
}) {
  const c = invoice.collection;
  const pending = invoice.status === 'issued' || invoice.status === 'overdue';
  if (!pending || !c) return null;
  const items: { key: string; label: string; title: string }[] = [];
  if (c.inFlight) {
    items.push({
      key: 'flight',
      label: 'Cobro en curso',
      title: 'Hay un cobro con tarjeta o domiciliación esperando respuesta del banco',
    });
  }
  if (c.inRemittance) {
    items.push({
      key: 'remittance',
      label: 'En remesa',
      title: 'Va en una remesa SEPA que aún no se ha confirmado',
    });
  }
  if (c.inPaymentPlan) {
    items.push({
      key: 'plan',
      label: 'Plan de pagos',
      title: 'Está en un plan de pagos: no se le reclama mientras lo cumpla',
    });
  }
  if (invoice.lateFeeInvoiceId) {
    items.push({ key: 'fee', label: 'Con recargo', title: 'Ya tiene un recargo por mora' });
  }
  if (c.lastReminderAt) {
    items.push({
      key: 'reminded',
      label: compact ? 'Recordada' : `Recordada el ${formatDate(c.lastReminderAt)}`,
      title: `Último recordatorio: ${formatDate(c.lastReminderAt)}`,
    });
  }
  if (items.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((b) => (
        <Badge key={b.key} variant="outline" className="font-normal" title={b.title}>
          {b.label}
        </Badge>
      ))}
    </span>
  );
}
