import { CUSTOMER_EMAIL_LABELS, type CustomerEmailKind } from '@storageos/shared';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

/** Forma de un cobro registrado, en palabras. */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  sepa_debit: 'Domiciliación',
  card: 'Tarjeta',
  other: 'Otra forma',
  credit_note: 'Saldo a favor o abono',
  withholding: 'Retención de IRPF',
};

export const PAYMENT_STATUS_LABELS: Record<string, { label: string; variant: BadgeVariant }> = {
  succeeded: { label: 'Cobrado', variant: 'default' },
  processing: { label: 'En curso', variant: 'secondary' },
  pending: { label: 'Pendiente', variant: 'secondary' },
  failed: { label: 'No entró', variant: 'destructive' },
  refunded: { label: 'Devuelto', variant: 'outline' },
  partially_refunded: { label: 'Devuelto en parte', variant: 'outline' },
};

/** Por dónde volvió el dinero de una devolución. */
export const REFUND_VIA_LABELS: Record<string, string> = {
  gateway: 'Por la misma tarjeta o cuenta',
  bank: 'En el TPV del banco',
  manual: 'A mano (efectivo o transferencia)',
  external: 'Hecha fuera y registrada aquí',
  credit: 'Como saldo a favor',
};

export const COMMUNICATION_STATUS_LABELS: Record<string, { label: string; variant: BadgeVariant }> =
  {
    pending: { label: 'En cola', variant: 'secondary' },
    processing: { label: 'Enviando', variant: 'secondary' },
    sent: { label: 'Enviado', variant: 'default' },
    delivered: { label: 'Entregado', variant: 'default' },
    bounced: { label: 'Rebotado', variant: 'destructive' },
    failed: { label: 'No salió', variant: 'destructive' },
    skipped: { label: 'No enviado', variant: 'outline' },
  };

/** Qué aviso fue, a partir de su origen técnico. */
export function invoiceNoticeLabel(source: string | null): string {
  if (!source) return 'Aviso';
  if (source === 'invoice.sent') return 'Factura enviada por correo';
  if (source === 'dunning.email_reminder') return 'Recordatorio de pago';
  if (source === 'dunning.reminder_summary') return 'Recordatorio de pago (con otras facturas)';
  if (source === 'bulk.manual_reminder') return 'Recordatorio enviado desde el panel';
  if (source === 'bulk.reminder_summary') {
    return 'Recordatorio enviado desde el panel (con otras facturas)';
  }
  if (source.startsWith('customer_email.')) {
    const kind = source.slice('customer_email.'.length) as CustomerEmailKind;
    return CUSTOMER_EMAIL_LABELS[kind]?.label ?? 'Aviso automático';
  }
  if (source.startsWith('automation')) return 'Automatización';
  return 'Aviso';
}

/** Pasos del escalado de impago. */
export const DUNNING_STEP_LABELS: Record<string, string> = {
  email_reminder: 'Primer recordatorio',
  email_reminder_final: 'Segundo aviso',
  sms_reminder: 'Recordatorio por SMS',
  late_fee: 'Recargo por mora',
  access_block: 'Corte del acceso',
  legal_notice: 'Expediente de impago',
};

export const DUNNING_STATUS_LABELS: Record<string, { label: string; variant: BadgeVariant }> = {
  scheduled: { label: 'Previsto', variant: 'secondary' },
  executed: { label: 'Hecho', variant: 'default' },
  failed: { label: 'Falló', variant: 'destructive' },
  cancelled: { label: 'No hizo falta', variant: 'outline' },
};
