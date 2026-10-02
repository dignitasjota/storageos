import { formatEur } from '../../common/format';
import { brandButton, tenantEmailShell } from '../../common/tenant-email-layout';

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

/**
 * Cómo se va a pagar una factura, para decírselo al inquilino en el correo:
 * cobro automático (tarjeta o adeudo por la pasarela), remesa SEPA del propio
 * tenant, o lo paga él (área de clientes y, si hay, transferencia).
 */
export type InvoicePaymentHint =
  | { via: 'auto_card'; brand: string | null; last4: string | null }
  | { via: 'auto_debit'; last4: string | null }
  | { via: 'sepa_remittance'; last4: string }
  | { via: 'manual'; transferIban: string | null };

export type CustomerEmailData =
  | {
      kind: 'invoice_issued';
      invoiceNumber: string;
      total: number;
      dueDate: Date | null;
      payment: InvoicePaymentHint;
    }
  | { kind: 'payment_received'; invoiceNumber: string; amount: number; paidAt: Date }
  | { kind: 'payment_failed'; invoiceNumber: string; amount: number; reason: string | null }
  | {
      kind: 'contract_signed';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      priceMonthly: number;
      startDate: Date;
    }
  | {
      kind: 'contract_ending_soon';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      endDate: Date;
    }
  | {
      kind: 'sepa_prenotification';
      invoiceNumber: string;
      amount: number;
      collectionDate: Date;
      ibanLast4: string;
      mandateReference: string;
      creditorName: string;
      creditorId: string;
    }
  | {
      kind: 'move_out_confirmed';
      contractNumber: string;
      unitCode: string;
      facilityName: string;
      endDate: Date;
    };

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
              `Start date: ${day(data.startDate, l)}. Monthly fee: ${eur(data.priceMonthly, l)}.`,
              'You can download a copy of the signed contract from your customer area.',
            ]
          : [
              `Tu contrato ${data.contractNumber} del trastero ${data.unitCode} en ${data.facilityName} ha quedado firmado.`,
              `Fecha de inicio: ${day(data.startDate, l)}. Cuota mensual: ${eur(data.priceMonthly, l)}.`,
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
    case 'sepa_prenotification':
      return {
        subject: en
          ? `Upcoming debit: ${eur(data.amount, l)} on ${day(data.collectionDate, l)}`
          : `Aviso de cargo en tu cuenta: ${eur(data.amount, l)} el ${day(data.collectionDate, l)}`,
        paragraphs: en
          ? [
              `On ${day(data.collectionDate, l)} we will debit ${eur(data.amount, l)} from your account ending in ${data.ibanLast4}, for invoice ${data.invoiceNumber}.`,
              `Creditor: ${data.creditorName} (identifier ${data.creditorId}). Mandate reference: ${data.mandateReference}.`,
              "You don't need to do anything. If you spot a mistake, please contact us before that date.",
            ]
          : [
              `El ${day(data.collectionDate, l)} cargaremos ${eur(data.amount, l)} en tu cuenta terminada en ${data.ibanLast4}, correspondiente a la factura ${data.invoiceNumber}.`,
              `Acreedor: ${data.creditorName} (identificador ${data.creditorId}). Referencia del mandato: ${data.mandateReference}.`,
              'No tienes que hacer nada. Si ves algún error, contacta con nosotros antes de esa fecha.',
            ],
        cta: en ? 'View my invoices' : 'Ver mis facturas',
      };
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
  const text = [
    greeting,
    ...paragraphs,
    `${c.cta}: ${base.portalUrl}`,
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
${brandButton(brand, base.portalUrl, c.cta)}
<p style="font-size:15px;line-height:24px">${regards}<br>${escapeHtml(base.tenantName)}</p>`,
  );
  return { subject: c.subject, text, html };
}
