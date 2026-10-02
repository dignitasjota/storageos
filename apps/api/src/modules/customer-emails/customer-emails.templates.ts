/** Datos comunes a todos los correos al inquilino. */
export interface CustomerEmailBase {
  tenantName: string;
  /** Nombre del inquilino (puede venir vacío). */
  customerName: string;
  /** Login del área de clientes del tenant. */
  portalUrl: string;
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

const eur = (n: number): string =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

const day = (d: Date): string =>
  new Intl.DateTimeFormat('es-ES', {
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

function paymentParagraphs(p: InvoicePaymentHint, invoiceNumber: string): string[] {
  switch (p.via) {
    case 'auto_card': {
      const card = [
        p.brand ? capitalize(p.brand) : 'tarjeta',
        p.last4 ? `terminada en ${p.last4}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return [`Te la cobraremos automáticamente en tu ${card}. No tienes que hacer nada.`];
    }
    case 'auto_debit':
      return [
        `Se cargará por domiciliación en tu cuenta${p.last4 ? ` terminada en ${p.last4}` : ''} en los próximos días. No tienes que hacer nada.`,
      ];
    case 'sepa_remittance':
      return [
        `Se cobrará por domiciliación en tu cuenta terminada en ${p.last4}. Antes del cargo te avisaremos de la fecha. No tienes que hacer nada.`,
      ];
    case 'manual':
      return p.transferIban
        ? [
            'Puedes pagarla con tarjeta desde tu área de clientes o por transferencia bancaria:',
            `IBAN: ${formatIban(p.transferIban)} · Concepto: ${invoiceNumber}`,
          ]
        : ['Puedes verla y pagarla desde tu área de clientes.'];
  }
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function content(data: CustomerEmailData): Content {
  switch (data.kind) {
    case 'invoice_issued':
      return {
        subject: `Nueva factura ${data.invoiceNumber}`,
        paragraphs: [
          `Te hemos emitido la factura ${data.invoiceNumber} por ${eur(data.total)}.`,
          data.dueDate ? `Vencimiento: ${day(data.dueDate)}.` : '',
          ...paymentParagraphs(data.payment, data.invoiceNumber),
        ],
        cta: data.payment.via === 'manual' ? 'Pagar ahora' : 'Ver mis facturas',
      };
    case 'payment_received':
      return {
        subject: `Pago recibido — factura ${data.invoiceNumber}`,
        paragraphs: [
          `Hemos recibido el pago de ${eur(data.amount)} de la factura ${data.invoiceNumber} (${day(data.paidAt)}). ¡Gracias!`,
          'Este correo te sirve de justificante. Tienes la factura en tu área de clientes.',
        ],
        cta: 'Ver mis facturas',
      };
    case 'payment_failed':
      return {
        subject: `No hemos podido cobrar la factura ${data.invoiceNumber}`,
        paragraphs: [
          `No hemos podido cobrar ${eur(data.amount)} de la factura ${data.invoiceNumber}${data.reason ? ` (${data.reason})` : ''}.`,
          'Revisa tu método de pago o paga la factura desde tu área de clientes para evitar recargos o cortes de acceso.',
        ],
        cta: 'Pagar ahora',
      };
    case 'contract_signed':
      return {
        subject: `Tu contrato ${data.contractNumber} está firmado`,
        paragraphs: [
          `Tu contrato ${data.contractNumber} del trastero ${data.unitCode} en ${data.facilityName} ha quedado firmado.`,
          `Fecha de inicio: ${day(data.startDate)}. Cuota mensual: ${eur(data.priceMonthly)}.`,
          'Puedes descargar una copia del contrato firmado en tu área de clientes.',
        ],
        cta: 'Ver mi contrato',
      };
    case 'contract_ending_soon':
      return {
        subject: `Tu contrato ${data.contractNumber} termina el ${day(data.endDate)}`,
        paragraphs: [
          `Te recordamos que tu contrato del trastero ${data.unitCode} en ${data.facilityName} termina el ${day(data.endDate)}.`,
          'Si quieres seguir, contacta con nosotros para renovarlo. Si no, recuerda dejar el trastero vacío antes de esa fecha.',
        ],
        cta: 'Ir a mi área de clientes',
      };
    case 'sepa_prenotification':
      return {
        subject: `Aviso de cargo en tu cuenta: ${eur(data.amount)} el ${day(data.collectionDate)}`,
        paragraphs: [
          `El ${day(data.collectionDate)} cargaremos ${eur(data.amount)} en tu cuenta terminada en ${data.ibanLast4}, correspondiente a la factura ${data.invoiceNumber}.`,
          `Acreedor: ${data.creditorName} (identificador ${data.creditorId}). Referencia del mandato: ${data.mandateReference}.`,
          'No tienes que hacer nada. Si ves algún error, contacta con nosotros antes de esa fecha.',
        ],
        cta: 'Ver mis facturas',
      };
    case 'move_out_confirmed':
      return {
        subject: `Hemos recibido tu solicitud de baja`,
        paragraphs: [
          `Hemos registrado la baja de tu trastero ${data.unitCode} en ${data.facilityName} (contrato ${data.contractNumber}) con fecha ${day(data.endDate)}.`,
          'Recuerda dejar el trastero vacío antes de esa fecha. Si ha sido un error, puedes cancelar la baja desde tu área de clientes.',
        ],
        cta: 'Ir a mi área de clientes',
      };
  }
}

/** Correo al inquilino con la marca del tenant (nunca la de la plataforma). */
export function renderCustomerEmail(
  base: CustomerEmailBase,
  data: CustomerEmailData,
): RenderedEmail {
  const c = content(data);
  const greeting = base.customerName ? `Hola ${base.customerName},` : 'Hola,';
  const paragraphs = c.paragraphs.filter(Boolean);
  const text = [
    greeting,
    ...paragraphs,
    `${c.cta}: ${base.portalUrl}`,
    `Un saludo,\n${base.tenantName}`,
  ].join('\n\n');
  const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:24px 0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:32px">
<p style="margin:0 0 16px;font-size:14px;font-weight:600;color:#2563eb">${escapeHtml(base.tenantName)}</p>
<p style="font-size:15px;line-height:24px">${escapeHtml(greeting)}</p>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:24px">${escapeHtml(p)}</p>`).join('\n')}
<p style="margin:24px 0;text-align:center"><a href="${escapeHtml(base.portalUrl)}" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-size:14px">${escapeHtml(c.cta)}</a></p>
<p style="font-size:15px;line-height:24px">Un saludo,<br>${escapeHtml(base.tenantName)}</p>
</div></body></html>`;
  return { subject: c.subject, text, html };
}
