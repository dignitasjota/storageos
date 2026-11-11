import { type EmailLocale, formatDateLong, formatEur } from '../../common/format';

import type { Prisma } from '@storageos/database';

/** Orígenes de los recordatorios de pago (para «uno al día» y el estado de cobro). */
export const REMINDER_SOURCES = [
  'bulk.manual_reminder',
  'bulk.reminder_summary',
  'dunning.email_reminder',
  'dunning.email_reminder_final',
  'dunning.reminder_summary',
];

/** Los que agrupan varias facturas: las llevan en `variables.invoiceIds`. */
export const SUMMARY_REMINDER_SOURCES = ['bulk.reminder_summary', 'dunning.reminder_summary'];

/** Recordatorios de una factura: los suyos y los resúmenes que la incluyen. */
export function remindersOfInvoice(invoiceId: string): Prisma.CommunicationWhereInput {
  return {
    status: { notIn: ['failed', 'skipped'] },
    OR: [
      { invoiceId, source: { in: REMINDER_SOURCES } },
      {
        source: { in: SUMMARY_REMINDER_SOURCES },
        variables: { path: ['invoiceIds'], array_contains: [invoiceId] },
      },
    ],
  };
}

export interface ReminderSummaryInvoice {
  number: string;
  pending: number;
  dueDate: Date | null;
}

/**
 * Un solo correo para un inquilino con varias facturas por pagar: cuáles son,
 * cuánto suman y dónde pagarlas.
 */
export function buildReminderSummary(args: {
  tenantName: string;
  customerName: string;
  locale: EmailLocale;
  invoices: ReminderSummaryInvoice[];
  portalUrl: string;
  /** Último aviso del escalado (antes del corte del acceso). */
  final?: boolean;
  /** Habrá corte del acceso si no paga (si no, no se menciona). */
  accessCutAhead?: boolean;
  today: Date;
}): { subject: string; text: string } {
  const en = args.locale === 'en';
  const total = args.invoices.reduce((sum, i) => sum + Math.round(i.pending * 100), 0) / 100;
  const n = args.invoices.length;
  const lines = args.invoices.map((i) => {
    const due = i.dueDate
      ? i.dueDate < args.today
        ? en
          ? ` (due on ${formatDateLong(i.dueDate, 'Europe/Madrid', 'en')})`
          : ` (venció el ${formatDateLong(i.dueDate, 'Europe/Madrid', 'es')})`
        : en
          ? ` (due ${formatDateLong(i.dueDate, 'Europe/Madrid', 'en')})`
          : ` (vence el ${formatDateLong(i.dueDate, 'Europe/Madrid', 'es')})`
      : '';
    return `· ${i.number}: ${formatEur(i.pending, args.locale)}${due}`;
  });
  const hello = args.customerName
    ? `${en ? 'Hello' : 'Hola'} ${args.customerName},`
    : `${en ? 'Hello' : 'Hola'},`;
  const subject = en
    ? args.final
      ? `Final notice: ${n} invoices pending payment`
      : `You have ${n} invoices pending payment`
    : args.final
      ? `Último aviso: ${n} facturas pendientes de pago`
      : `Tienes ${n} facturas pendientes de pago`;
  const text = [
    hello,
    en
      ? `You have ${n} invoices pending payment, for a total of ${formatEur(total, 'en')}:`
      : `Tienes ${n} facturas pendientes de pago, por un total de ${formatEur(total, 'es')}:`,
    lines.join('\n'),
    en
      ? `You can pay them from your customer area: ${args.portalUrl}`
      : `Puedes pagarlas desde tu área de clientes: ${args.portalUrl}`,
    args.final
      ? args.accessCutAhead === false
        ? en
          ? 'Please settle them as soon as possible.'
          : 'Te pedimos que las regularices cuanto antes.'
        : en
          ? 'If they are not paid, access to your storage unit may be suspended.'
          : 'Si no se pagan, el acceso a tu trastero puede quedar suspendido.'
      : en
        ? 'If you have already paid them, please ignore this message.'
        : 'Si ya las has pagado, no hagas caso de este mensaje.',
    `${en ? 'Kind regards,' : 'Un saludo,'}\n${args.tenantName}`,
  ].join('\n\n');
  return { subject, text };
}
