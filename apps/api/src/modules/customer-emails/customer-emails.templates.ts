import { formatEur } from '../../common/format';
import { brandButton, tenantEmailShell } from '../../common/tenant-email-layout';

import type { InvoicePaymentHint } from '../../common/invoice-payment-hint';

export type { InvoicePaymentHint } from '../../common/invoice-payment-hint';

/** Datos comunes a todos los correos al inquilino. */
export interface CustomerEmailBase {
  tenantName: string;
  /** Nombre del inquilino (puede venir vacío). */
  customerName: string;
  /** Login del área de clientes del tenant. */
  portalUrl: string;
  /** Idioma del inquilino (`customers.locale`): `es` por defecto o `en`. */
  locale?: string | null;
  /** Marca del tenant (Ajustes → Marca del portal). */
  logoUrl?: string | null;
  brandColor?: string | null;
}

export type CustomerEmailData =
  | {
      kind: 'invoice_issued';
      invoiceNumber: string;
      total: number;
      dueDate: Date | null;
      payment: InvoicePaymentHint;
      /** Descarga del PDF sin iniciar sesión. */
      pdfUrl?: string | null;
    }
  | {
      kind: 'payment_received';
      invoiceNumber: string;
      amount: number;
      paidAt: Date;
      /** Justificante de fianza (FZ-…) cobrado aparte: no es una factura. */
      depositReceipt?: boolean;
      /** Descarga del PDF (ya con el sello de pagada). */
      pdfUrl?: string | null;
    }
  | { kind: 'payment_failed'; invoiceNumber: string; amount: number; reason: string | null }
  | {
      /** Copia que el equipo envía a mano desde la factura. */
      kind: 'invoice_copy';
      invoiceNumber: string;
      total: number;
      dueDate: Date | null;
      paidAt: Date | null;
      /** Cómo pagarla (solo si está pendiente). */
      payment: InvoicePaymentHint | null;
      pdfUrl: string | null;
    }
  | {
      kind: 'contract_signed';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      priceMonthly: number;
      startDate: Date;
      /** Reserva antes de la apertura (null si no lo es o ya empezó). */
      preOpening?: { openingDate: Date | null } | null;
      /** Cómo llegar al local (indicaciones del negocio). */
      directions?: string | null;
    }
  | {
      kind: 'contract_ending_soon';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      endDate: Date;
    }
  | {
      kind: 'contract_renewed';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      endDate: Date;
      /** Cuota del nuevo periodo, si cambia. */
      newPrice?: { monthlyWithVat: number; from: Date } | null;
    }
  | {
      kind: 'contract_price_change';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      monthlyWithVat: number;
      effectiveDate: Date;
      canLeaveWithoutNotice?: boolean;
    }
  | {
      /** Preaviso de una tanda de Subidas de precio (condición 4 del contrato). */
      kind: 'rent_increase_notice';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      oldMonthlyWithVat: number;
      newMonthlyWithVat: number;
      effectiveDate: Date;
      /** Paga por adelantado: la cuota nueva vale desde su siguiente periodo. */
      prepaid: boolean;
    }
  | {
      kind: 'rent_increase_cancelled';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      monthlyWithVat: number;
      effectiveDate: Date;
    }
  | {
      kind: 'deposit_settled';
      contractNumber: string;
      unitCode: string;
      deposit: number;
      returned: number;
      retained: number;
      applied: number;
      reason: string | null;
    }
  | {
      kind: 'sepa_prenotification';
      invoiceNumber: string;
      /** El total de los cargos de ese día. */
      amount: number;
      collectionDate: Date;
      ibanLast4: string;
      mandateReference: string;
      creditorName: string;
      creditorId: string;
      /** Varias facturas del inquilino en la remesa: un cargo por factura. */
      invoices?: { number: string; amount: number }[];
    }
  | {
      kind: 'move_out_confirmed';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      endDate: Date;
    }
  | {
      kind: 'reservation_held' | 'reservation_expiring';
      unitCode: string;
      facilityName: string;
      validUntil: Date;
      /** Señal pendiente de pagar (0 si no hay o ya está pagada). */
      signalDue: number;
    }
  | {
      /** Reserva online cancelada por no pagarse a tiempo. */
      kind: 'booking_expired';
      unitCode: string;
      facilityName: string;
      /** Había firmado (solo faltaba pagar). */
      signed: boolean;
      /** Tenía factura y se ha anulado. */
      invoiceCancelled: boolean;
      /** Reserva online del negocio, con el local y el tamaño ya elegidos. */
      bookingUrl: string;
    }
  | {
      kind: 'unit_request_resolved';
      request: 'change' | 'additional';
      outcome: 'moved' | 'handled' | 'rejected';
      note: string | null;
    }
  | { kind: 'staff_message'; tenantName: string; body: string; viaEmail?: boolean };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Locale = 'es' | 'en';

const eur = (n: number, l: Locale): string => formatEur(n, l);

const day = (d: Date, l: Locale): string =>
  new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Madrid',
  }).format(d);

export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Content {
  subject: string;
  /** Párrafos en texto plano (se escapan al pasar a HTML). */
  paragraphs: string[];
  cta: string;
  /** A dónde lleva el botón (por defecto, el área de clientes). */
  ctaUrl?: string;
  /** Enlace secundario bajo el botón (p. ej. la factura en PDF). */
  link?: { label: string; url: string } | null;
}

/** «Descargar la factura en PDF», si hay enlace. */
function pdfLink(url: string | null | undefined, l: Locale): { label: string; url: string } | null {
  if (!url) return null;
  return { label: l === 'en' ? 'Download the invoice (PDF)' : 'Descargar la factura en PDF', url };
}

/** «ES9121000418450200051332» → «ES91 2100 0418 4502 0005 1332». */
export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function paymentParagraphs(p: InvoicePaymentHint, invoiceNumber: string, l: Locale): string[] {
  const en = l === 'en';
  switch (p.via) {
    case 'auto_card': {
      const brand = p.brand ? capitalize(p.brand) : en ? 'card' : 'tarjeta';
      const ending = p.last4 ? (en ? ` ending in ${p.last4}` : ` terminada en ${p.last4}`) : '';
      return [
        en
          ? `We will charge it automatically to your ${brand}${ending}. You don't need to do anything.`
          : `Te la cobraremos automáticamente en tu ${brand}${ending}. No tienes que hacer nada.`,
      ];
    }
    case 'auto_debit': {
      const ending = p.last4 ? (en ? ` ending in ${p.last4}` : ` terminada en ${p.last4}`) : '';
      return [
        en
          ? `It will be collected by direct debit from your account${ending} in the coming days. You don't need to do anything.`
          : `Se cargará por domiciliación en tu cuenta${ending} en los próximos días. No tienes que hacer nada.`,
      ];
    }
    case 'sepa_remittance':
      return [
        en
          ? `It will be collected by direct debit from your account ending in ${p.last4}. We will let you know the date before the charge. You don't need to do anything.`
          : `Se cobrará por domiciliación en tu cuenta terminada en ${p.last4}. Antes del cargo te avisaremos de la fecha. No tienes que hacer nada.`,
      ];
    case 'manual':
      return p.transferIban
        ? [
            en
              ? 'You can pay it by card from your customer area or by bank transfer:'
              : 'Puedes pagarla con tarjeta desde tu área de clientes o por transferencia bancaria:',
            `IBAN: ${formatIban(p.transferIban)} · ${en ? 'Reference' : 'Concepto'}: ${invoiceNumber}`,
          ]
        : [
            en
              ? 'You can view and pay it from your customer area.'
              : 'Puedes verla y pagarla desde tu área de clientes.',
          ];
  }
}

function content(data: CustomerEmailData, l: Locale): Content {
  const en = l === 'en';
  switch (data.kind) {
    case 'invoice_issued':
      return {
        subject: en ? `New invoice ${data.invoiceNumber}` : `Nueva factura ${data.invoiceNumber}`,
        paragraphs: [
          en
            ? `We have issued invoice ${data.invoiceNumber} for ${eur(data.total, l)}.`
            : `Te hemos emitido la factura ${data.invoiceNumber} por ${eur(data.total, l)}.`,
          data.dueDate
            ? en
              ? `Due date: ${day(data.dueDate, l)}.`
              : `Vencimiento: ${day(data.dueDate, l)}.`
            : '',
          ...paymentParagraphs(data.payment, data.invoiceNumber, l),
        ],
        link: pdfLink(data.pdfUrl, l),
        cta:
          data.payment.via === 'manual'
            ? en
              ? 'Pay now'
              : 'Pagar ahora'
            : en
              ? 'View my invoices'
              : 'Ver mis facturas',
      };
    case 'payment_received':
      if (data.depositReceipt) {
        return {
          subject: en
            ? `Deposit received — receipt ${data.invoiceNumber}`
            : `Fianza recibida — justificante ${data.invoiceNumber}`,
          paragraphs: en
            ? [
                `We have received your deposit of ${eur(data.amount, l)} (${day(data.paidAt, l)}). Receipt: ${data.invoiceNumber}.`,
                'The deposit is returned at the end of the contract, minus any damage or amounts owed. You have the receipt in your customer area.',
              ]
            : [
                `Hemos recibido tu fianza de ${eur(data.amount, l)} (${day(data.paidAt, l)}). Justificante: ${data.invoiceNumber}.`,
                'La fianza se devuelve al terminar el contrato, descontando los daños o las cantidades pendientes. Tienes el justificante en tu área de clientes.',
              ],
          cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
        };
      }
      return {
        subject: en
          ? `Payment received — invoice ${data.invoiceNumber}`
          : `Pago recibido — factura ${data.invoiceNumber}`,
        paragraphs: en
          ? [
              `We have received the payment of ${eur(data.amount, l)} for invoice ${data.invoiceNumber} (${day(data.paidAt, l)}). Thank you!`,
              'This email serves as your receipt. The invoice is in your customer area.',
            ]
          : [
              `Hemos recibido el pago de ${eur(data.amount, l)} de la factura ${data.invoiceNumber} (${day(data.paidAt, l)}). ¡Gracias!`,
              'Este correo te sirve de justificante. Tienes la factura en tu área de clientes.',
            ],
        link: pdfLink(data.pdfUrl, l),
        cta: en ? 'View my invoices' : 'Ver mis facturas',
      };
    case 'invoice_copy':
      return {
        subject: en ? `Invoice ${data.invoiceNumber}` : `Factura ${data.invoiceNumber}`,
        paragraphs: [
          en
            ? `Here is invoice ${data.invoiceNumber} for ${eur(data.total, l)}.`
            : `Te enviamos la factura ${data.invoiceNumber} por ${eur(data.total, l)}.`,
          data.paidAt
            ? en
              ? `It is paid (${day(data.paidAt, l)}). Thank you!`
              : `Está pagada (${day(data.paidAt, l)}). ¡Gracias!`
            : data.dueDate
              ? en
                ? `Due date: ${day(data.dueDate, l)}.`
                : `Vencimiento: ${day(data.dueDate, l)}.`
              : '',
          ...(data.payment && !data.paidAt
            ? paymentParagraphs(data.payment, data.invoiceNumber, l)
            : []),
        ].filter(Boolean),
        link: pdfLink(data.pdfUrl, l),
        cta: en ? 'View my invoices' : 'Ver mis facturas',
      };
    case 'payment_failed':
      return {
        subject: en
          ? `We could not collect invoice ${data.invoiceNumber}`
          : `No hemos podido cobrar la factura ${data.invoiceNumber}`,
        paragraphs: en
          ? [
              `We could not collect ${eur(data.amount, l)} for invoice ${data.invoiceNumber}${data.reason ? ` (${data.reason})` : ''}.`,
              'Please check your payment method or pay the invoice from your customer area to avoid late fees or access being suspended.',
            ]
          : [
              `No hemos podido cobrar ${eur(data.amount, l)} de la factura ${data.invoiceNumber}${data.reason ? ` (${data.reason})` : ''}.`,
              'Revisa tu método de pago o paga la factura desde tu área de clientes para evitar recargos o cortes de acceso.',
            ],
        cta: en ? 'Pay now' : 'Pagar ahora',
      };
    case 'contract_signed':
      return {
        subject: en
          ? `Your contract ${data.contractNumber} is signed`
          : `Tu contrato ${data.contractNumber} está firmado`,
        paragraphs: en
          ? [
              `Your contract ${data.contractNumber} for storage unit ${data.unitCode} at ${data.facilityName} has been signed.`,
              data.preOpening
                ? `Your rental starts the day the facility opens${data.preOpening.openingDate ? ` (expected on ${day(data.preOpening.openingDate, l)})` : ' (date to be confirmed; we will let you know)'}. Monthly fee: ${eur(data.priceMonthly, l)}.`
                : `Start date: ${day(data.startDate, l)}. Monthly fee: ${eur(data.priceMonthly, l)}.`,
              ...(data.directions ? [`How to get there: ${data.directions}`] : []),
              'You can download a copy of the signed contract from your customer area.',
            ]
          : [
              `Tu contrato ${data.contractNumber} del trastero ${data.unitCode} en ${data.facilityName} ha quedado firmado.`,
              data.preOpening
                ? `Tu alquiler empieza el día de apertura del local${data.preOpening.openingDate ? ` (prevista para el ${day(data.preOpening.openingDate, l)})` : ' (fecha por confirmar; te avisaremos)'}. Cuota mensual: ${eur(data.priceMonthly, l)}.`
                : `Fecha de inicio: ${day(data.startDate, l)}. Cuota mensual: ${eur(data.priceMonthly, l)}.`,
              ...(data.directions ? [`Cómo llegar: ${data.directions}`] : []),
              'Puedes descargar una copia del contrato firmado en tu área de clientes.',
            ],
        cta: en ? 'View my contract' : 'Ver mi contrato',
      };
    case 'contract_ending_soon':
      return {
        subject: en
          ? `Your contract ${data.contractNumber} ends on ${day(data.endDate, l)}`
          : `Tu contrato ${data.contractNumber} termina el ${day(data.endDate, l)}`,
        paragraphs: en
          ? [
              `This is a reminder that your contract for storage unit ${data.unitCode} at ${data.facilityName} ends on ${day(data.endDate, l)}.`,
              'If you want to stay, get in touch to renew it. Otherwise, please leave the unit empty before that date.',
            ]
          : [
              `Te recordamos que tu contrato del trastero ${data.unitCode} en ${data.facilityName} termina el ${day(data.endDate, l)}.`,
              'Si quieres seguir, contacta con nosotros para renovarlo. Si no, recuerda dejar el trastero vacío antes de esa fecha.',
            ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    case 'contract_renewed':
      return {
        subject: en
          ? `Your contract ${data.contractNumber} has been renewed`
          : `Tu contrato ${data.contractNumber} se ha renovado`,
        paragraphs: en
          ? [
              `Your contract for storage unit ${data.unitCode} at ${data.facilityName} has been renewed until ${day(data.endDate, l)}.`,
              data.newPrice
                ? `From ${day(data.newPrice.from, l)}, the monthly fee will be ${eur(data.newPrice.monthlyWithVat, l)} (VAT included).`
                : 'Nothing else changes: you can keep using your unit as usual.',
              data.newPrice ? 'If you have any questions, get in touch with us.' : '',
            ]
          : [
              `Tu contrato del trastero ${data.unitCode} en ${data.facilityName} se ha renovado hasta el ${day(data.endDate, l)}.`,
              data.newPrice
                ? `Desde el ${day(data.newPrice.from, l)}, la cuota mensual será de ${eur(data.newPrice.monthlyWithVat, l)} (IVA incluido).`
                : 'No tienes que hacer nada: sigues usando tu trastero como hasta ahora.',
              data.newPrice ? 'Si tienes cualquier duda, contacta con nosotros.' : '',
            ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    case 'contract_price_change':
      return {
        subject: en
          ? `New monthly fee for contract ${data.contractNumber}`
          : `Nueva cuota de tu contrato ${data.contractNumber}`,
        paragraphs: en
          ? [
              `From ${day(data.effectiveDate, l)}, the monthly fee for storage unit ${data.unitCode} at ${data.facilityName} will be ${eur(data.monthlyWithVat, l)} (VAT included).`,
              data.canLeaveWithoutNotice
                ? 'If you do not agree, you can cancel your contract before that date without notice or penalty, from your customer area or by replying to this email.'
                : '',
              'If you have any questions, get in touch with us.',
            ]
          : [
              `Desde el ${day(data.effectiveDate, l)}, la cuota mensual del trastero ${data.unitCode} en ${data.facilityName} será de ${eur(data.monthlyWithVat, l)} (IVA incluido).`,
              data.canLeaveWithoutNotice
                ? 'Si no estás de acuerdo, puedes darte de baja antes de esa fecha sin preaviso ni penalización, desde tu área de clientes o contestando a este correo.'
                : '',
              'Si tienes cualquier duda, contacta con nosotros.',
            ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    case 'rent_increase_notice':
      return {
        subject: en
          ? `New monthly fee for your storage unit ${data.unitCode}`
          : `Revisión de la cuota de tu trastero ${data.unitCode}`,
        paragraphs: en
          ? [
              `From ${day(data.effectiveDate, l)}, the monthly fee for storage unit ${data.unitCode} at ${data.facilityName} (contract ${data.contractNumber}) will go from ${eur(data.oldMonthlyWithVat, l)} to ${eur(data.newMonthlyWithVat, l)} (VAT included).`,
              data.prepaid
                ? 'As you pay in advance, the new fee applies from your next period, which starts on that date.'
                : '',
              'If you do not agree, you can cancel your contract before that date without notice or penalty, from your customer area or by replying to this email.',
              'If you have any questions, get in touch with us.',
            ]
          : [
              `Desde el ${day(data.effectiveDate, l)}, la cuota mensual de tu trastero ${data.unitCode} en ${data.facilityName} (contrato ${data.contractNumber}) pasará de ${eur(data.oldMonthlyWithVat, l)} a ${eur(data.newMonthlyWithVat, l)} (IVA incluido).`,
              data.prepaid
                ? 'Como pagas por adelantado, la cuota nueva se aplica desde tu siguiente periodo, que empieza ese día.'
                : '',
              'Si no estás de acuerdo, puedes darte de baja antes de esa fecha sin preaviso ni penalización, desde tu área de clientes o contestando a este correo.',
              'Si tienes cualquier duda, contacta con nosotros.',
            ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    case 'rent_increase_cancelled':
      return {
        subject: en
          ? `The fee review for your storage unit ${data.unitCode} is cancelled`
          : `Anulada la revisión de la cuota de tu trastero ${data.unitCode}`,
        paragraphs: en
          ? [
              `The new monthly fee we announced for ${day(data.effectiveDate, l)} for storage unit ${data.unitCode} at ${data.facilityName} will not apply.`,
              `Your fee stays at ${eur(data.monthlyWithVat, l)} a month (VAT included).`,
            ]
          : [
              `La nueva cuota que te anunciamos para el ${day(data.effectiveDate, l)} del trastero ${data.unitCode} en ${data.facilityName} queda anulada.`,
              `Tu cuota sigue siendo de ${eur(data.monthlyWithVat, l)} al mes (IVA incluido).`,
            ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    case 'deposit_settled':
      return {
        subject: en
          ? `Deposit settlement — contract ${data.contractNumber}`
          : `Liquidación de la fianza — contrato ${data.contractNumber}`,
        paragraphs: [
          en
            ? `This is the settlement of the ${eur(data.deposit, l)} deposit for storage unit ${data.unitCode}.`
            : `Esta es la liquidación de la fianza de ${eur(data.deposit, l)} del trastero ${data.unitCode}.`,
          en ? `Returned: ${eur(data.returned, l)}.` : `Devuelto: ${eur(data.returned, l)}.`,
          ...(data.retained > 0
            ? [
                en
                  ? `Retained: ${eur(data.retained, l)}${data.reason ? ` (${data.reason})` : ''}.`
                  : `Retenido: ${eur(data.retained, l)}${data.reason ? ` (${data.reason})` : ''}.`,
              ]
            : []),
          ...(data.applied > 0
            ? [
                en
                  ? `${eur(data.applied, l)} of it has been applied to your pending invoices.`
                  : `De ello, ${eur(data.applied, l)} se han aplicado a tus facturas pendientes.`,
              ]
            : []),
        ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    case 'sepa_prenotification': {
      const several = data.invoices && data.invoices.length > 1 ? data.invoices : null;
      const charges = several
        ? several
            .map((i) =>
              en
                ? `invoice ${i.number} (${eur(i.amount, l)})`
                : `factura ${i.number} (${eur(i.amount, l)})`,
            )
            .join(', ')
        : null;
      return {
        subject: en
          ? `Upcoming debit: ${eur(data.amount, l)} on ${day(data.collectionDate, l)}`
          : `Aviso de cargo en tu cuenta: ${eur(data.amount, l)} el ${day(data.collectionDate, l)}`,
        paragraphs: en
          ? [
              several
                ? `On ${day(data.collectionDate, l)} we will debit ${eur(data.amount, l)} from your account ending in ${data.ibanLast4}, in ${several.length} charges: ${charges}.`
                : `On ${day(data.collectionDate, l)} we will debit ${eur(data.amount, l)} from your account ending in ${data.ibanLast4}, for invoice ${data.invoiceNumber}.`,
              `Creditor: ${data.creditorName} (identifier ${data.creditorId}). Mandate reference: ${data.mandateReference}.`,
              "You don't need to do anything. If you spot a mistake, please contact us before that date.",
            ]
          : [
              several
                ? `El ${day(data.collectionDate, l)} cargaremos ${eur(data.amount, l)} en tu cuenta terminada en ${data.ibanLast4}, en ${several.length} cargos: ${charges}.`
                : `El ${day(data.collectionDate, l)} cargaremos ${eur(data.amount, l)} en tu cuenta terminada en ${data.ibanLast4}, correspondiente a la factura ${data.invoiceNumber}.`,
              `Acreedor: ${data.creditorName} (identificador ${data.creditorId}). Referencia del mandato: ${data.mandateReference}.`,
              'No tienes que hacer nada. Si ves algún error, contacta con nosotros antes de esa fecha.',
            ],
        cta: en ? 'View my invoices' : 'Ver mis facturas',
      };
    }
    case 'move_out_confirmed':
      return {
        subject: en
          ? 'We have received your move-out request'
          : 'Hemos recibido tu solicitud de baja',
        paragraphs: en
          ? [
              `We have registered the move-out of storage unit ${data.unitCode} at ${data.facilityName} (contract ${data.contractNumber}) on ${day(data.endDate, l)}.`,
              'Please leave the unit empty before that date. If this was a mistake, you can cancel it from your customer area.',
            ]
          : [
              `Hemos registrado la baja de tu trastero ${data.unitCode} en ${data.facilityName} (contrato ${data.contractNumber}) con fecha ${day(data.endDate, l)}.`,
              'Recuerda dejar el trastero vacío antes de esa fecha. Si ha sido un error, puedes cancelar la baja desde tu área de clientes.',
            ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    case 'reservation_held':
    case 'reservation_expiring': {
      const held = data.kind === 'reservation_held';
      const until = day(data.validUntil, l);
      return {
        subject: held
          ? en
            ? `We are holding storage unit ${data.unitCode} for you`
            : `Te guardamos el trastero ${data.unitCode}`
          : en
            ? `Your reservation of unit ${data.unitCode} ends soon`
            : `Tu reserva del trastero ${data.unitCode} está a punto de caducar`,
        paragraphs: [
          held
            ? en
              ? `We are holding storage unit ${data.unitCode} at ${data.facilityName} for you until ${until}.`
              : `Te guardamos el trastero ${data.unitCode} en ${data.facilityName} hasta el ${until}.`
            : en
              ? `Your reservation of storage unit ${data.unitCode} at ${data.facilityName} ends on ${until}. After that date it will be available to others.`
              : `Tu reserva del trastero ${data.unitCode} en ${data.facilityName} termina el ${until}. A partir de esa fecha quedará libre para otras personas.`,
          data.signalDue > 0
            ? en
              ? `To keep it, pay the deposit of ${eur(data.signalDue, l)} from your customer area.`
              : `Para mantenerla, paga la señal de ${eur(data.signalDue, l)} desde tu área de clientes.`
            : en
              ? 'If you have any questions, just reply to this email.'
              : 'Si tienes cualquier duda, responde a este correo.',
        ],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    }
    case 'booking_expired':
      return {
        subject: en
          ? `Your booking of storage unit ${data.unitCode} has been cancelled`
          : `Tu reserva del trastero ${data.unitCode} se ha cancelado`,
        paragraphs: en
          ? [
              data.signed
                ? `We haven't received the payment for your booking of storage unit ${data.unitCode} at ${data.facilityName}, so it has been cancelled and the unit is available again.`
                : `Your booking of storage unit ${data.unitCode} at ${data.facilityName} wasn't completed in time (the contract was not signed and paid), so it has been cancelled and the unit is available again.`,
              data.invoiceCancelled
                ? "You don't need to pay anything: the booking and its invoice have been cancelled."
                : "You don't need to pay anything.",
              'If you still need it, you can book again whenever you like.',
            ]
          : [
              data.signed
                ? `No hemos recibido el pago de tu reserva del trastero ${data.unitCode} en ${data.facilityName}, así que se ha cancelado y el trastero ha vuelto a quedar libre.`
                : `Tu reserva del trastero ${data.unitCode} en ${data.facilityName} no se terminó a tiempo (faltaba firmar el contrato y pagar), así que se ha cancelado y el trastero ha vuelto a quedar libre.`,
              data.invoiceCancelled
                ? 'No tienes que pagar nada: la reserva y su factura quedan anuladas.'
                : 'No tienes que pagar nada.',
              'Si todavía lo necesitas, puedes volver a reservarlo cuando quieras.',
            ],
        cta: en ? 'Book again' : 'Volver a reservar',
        ctaUrl: data.bookingUrl,
      };
    case 'unit_request_resolved': {
      const change = data.request === 'change';
      const what = en
        ? change
          ? 'storage unit change'
          : 'storage unit'
        : change
          ? 'cambio de trastero'
          : 'trastero';
      const lead =
        data.outcome === 'moved'
          ? en
            ? 'Your storage unit change is arranged.'
            : 'Tu cambio de trastero ya está gestionado.'
          : data.outcome === 'handled'
            ? en
              ? `We have dealt with your ${what} request.`
              : `Hemos atendido tu solicitud de ${what}.`
            : en
              ? `We have not been able to accept your ${what} request.`
              : `No hemos podido atender tu solicitud de ${what}.`;
      return {
        subject: en ? `About your ${what} request` : `Sobre tu solicitud de ${what}`,
        paragraphs: [lead, data.note ?? ''],
        cta: en ? 'Go to my customer area' : 'Ir a mi área de clientes',
      };
    }
    case 'staff_message':
      return {
        subject: en
          ? `New message from ${data.tenantName}`
          : `Tienes un mensaje de ${data.tenantName}`,
        paragraphs: [
          en
            ? 'We have written to you in your customer area:'
            : 'Te hemos escrito en tu área de clientes:',
          data.body,
          data.viaEmail
            ? en
              ? 'You can reply to this email or from the Messages tab of your customer area.'
              : 'Puedes responder a este correo o desde la pestaña «Mensajes» de tu área de clientes.'
            : en
              ? 'Reply from the Messages tab of your customer area: an answer to this email does not reach the conversation.'
              : 'Responde desde la pestaña «Mensajes» de tu área de clientes: una respuesta a este correo no llega a la conversación.',
        ],
        cta: en ? 'Read and reply' : 'Leer y responder',
      };
  }
}

/** Correo al inquilino con la marca del tenant (nunca la de la plataforma). */
export function renderCustomerEmail(
  base: CustomerEmailBase,
  data: CustomerEmailData,
): RenderedEmail {
  const l: Locale = base.locale === 'en' ? 'en' : 'es';
  const c = content(data, l);
  const hello = l === 'en' ? 'Hello' : 'Hola';
  const greeting = base.customerName ? `${hello} ${base.customerName},` : `${hello},`;
  const regards = l === 'en' ? 'Kind regards,' : 'Un saludo,';
  const paragraphs = c.paragraphs.filter(Boolean);
  const ctaUrl = c.ctaUrl ?? base.portalUrl;
  const text = [
    greeting,
    ...paragraphs,
    `${c.cta}: ${ctaUrl}`,
    ...(c.link ? [`${c.link.label}: ${c.link.url}`] : []),
    `${regards}\n${base.tenantName}`,
  ].join('\n\n');
  const brand = {
    name: base.tenantName,
    logoUrl: base.logoUrl ?? null,
    brandColor: base.brandColor ?? null,
  };
  const html = tenantEmailShell(
    brand,
    `<p style="font-size:15px;line-height:24px">${escapeHtml(greeting)}</p>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:24px">${escapeHtml(p)}</p>`).join('\n')}
${brandButton(brand, ctaUrl, c.cta)}
${
  c.link
    ? `<p style="font-size:14px;line-height:22px"><a href="${escapeHtml(c.link.url)}">${escapeHtml(c.link.label)}</a></p>`
    : ''
}
<p style="font-size:15px;line-height:24px">${regards}<br>${escapeHtml(base.tenantName)}</p>`,
  );
  return { subject: c.subject, text, html };
}
