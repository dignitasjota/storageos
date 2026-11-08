import {
  INVOICE_TAX_CATEGORY_LEGAL_TEXT,
  isExemptCategory,
  VERIFACTU_INVOICE_LEGEND,
  VERIFACTU_QR_LABEL,
  type InvoiceDto,
  type InvoiceTaxCategory,
} from '@storageos/shared';

import type { InvoicePaymentHint } from '../../common/invoice-payment-hint';

/** Quien emite la factura: el negocio o, en el plan Administrador, el propietario. */
export interface InvoicePdfIssuer {
  name: string;
  /** Razón social si difiere del nombre comercial. */
  legalName?: string | null;
  taxId: string | null;
  country: string;
  billingEmail: string | null;
  address?: string;
  managedBy?: string;
}

export interface InvoicePdfCustomer {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  customerType: 'individual' | 'business';
  documentType: string | null;
  documentNumber: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
}

const RECTIFICATION_LABELS: Record<string, string> = {
  R1: 'error fundado en derecho (art. 80.Uno, Dos y Seis LIVA)',
  R2: 'concurso de acreedores (art. 80.Tres LIVA)',
  R3: 'créditos incobrables (art. 80.Cuatro LIVA)',
  R4: 'otras causas',
  R5: 'factura simplificada',
};

/** Forma de un cobro, en palabras. */
const METHOD_WORDS: Record<string, string> = {
  card: 'tarjeta',
  sepa_debit: 'domiciliación',
  bank_transfer: 'transferencia',
  cash: 'efectivo',
  other: 'otro medio',
};

/** «ES9121000418450200051332» → «ES91 2100 0418 4502 0005 1332». */
function ibanGroups(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

/** Cómo pagar una factura pendiente, en una o dos frases. */
export function paymentLines(p: InvoicePaymentHint, invoiceNumber: string): string[] {
  switch (p.via) {
    case 'auto_card':
      return [
        `Se cobrará automáticamente en la tarjeta${p.brand ? ` ${p.brand}` : ''}${
          p.last4 ? ` terminada en ${p.last4}` : ''
        }.`,
      ];
    case 'auto_debit':
      return [
        `Se cargará por domiciliación en la cuenta${p.last4 ? ` terminada en ${p.last4}` : ''}.`,
      ];
    case 'sepa_remittance':
      return [`Se cobrará por domiciliación en la cuenta terminada en ${p.last4}.`];
    case 'manual':
      return p.transferIban
        ? [
            `Por transferencia a ${ibanGroups(p.transferIban)} indicando ${invoiceNumber}.`,
            'También puedes pagarla con tarjeta desde tu área de clientes.',
          ]
        : ['Puedes pagarla desde tu área de clientes.'];
  }
}

/** Título del documento según lo que es. */
export function invoiceDocTitle(i: Pick<InvoiceDto, 'kind' | 'invoiceType'>): string {
  if (i.kind === 'deposit_receipt') return 'Justificante de fianza';
  if (i.invoiceType.startsWith('R')) return 'Factura rectificativa';
  if (i.invoiceType === 'F2') return 'Factura simplificada';
  return 'Factura';
}

/** `2026-11-07` → `07/11/2026`. */
function day(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function eur(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Breakdown {
  /** Base e IVA por tipo, de las líneas con IVA. */
  taxed: { rate: number; base: number; tax: number }[];
  exempt: number;
  notSubject: number;
}

/**
 * Desglose fiscal de las líneas: la base imponible solo es lo que lleva IVA;
 * lo exento y lo no sujeto (la fianza, el recargo por mora) van aparte.
 */
export function invoiceBreakdown(items: InvoiceDto['items']): Breakdown {
  const byRate = new Map<number, { base: number; tax: number }>();
  let exempt = 0;
  let notSubject = 0;
  for (const it of items) {
    const baseCents = Math.round((it.total - it.taxAmount) * 100);
    const category = it.taxCategory as InvoiceTaxCategory;
    if (category === 'S1') {
      const row = byRate.get(it.taxRate) ?? { base: 0, tax: 0 };
      row.base += baseCents;
      row.tax += Math.round(it.taxAmount * 100);
      byRate.set(it.taxRate, row);
    } else if (isExemptCategory(category)) {
      exempt += baseCents;
    } else {
      notSubject += baseCents;
    }
  }
  return {
    taxed: [...byRate.entries()]
      .sort(([a], [b]) => b - a)
      .map(([rate, v]) => ({ rate, base: v.base / 100, tax: v.tax / 100 })),
    exempt: exempt / 100,
    notSubject: notSubject / 100,
  };
}

/**
 * HTML del PDF de una factura (o de un justificante de fianza). No dice lo que
 * falta por pagar; sí cómo pagarla mientras está pendiente y el sello de
 * «Pagada» cuando lo está (se rehace al pagarla, devolverla o corregir un cobro).
 */
export function renderInvoiceHtml(args: {
  invoice: InvoiceDto;
  issuer: InvoicePdfIssuer;
  customer: InvoicePdfCustomer | null;
  /** Logo del negocio como data URI (PNG o JPG). */
  logo?: string | null;
  /** Color de la marca (`#rrggbb`). */
  brandColor?: string | null;
  /** Cómo pagarla, si está pendiente. */
  payment?: InvoicePaymentHint | null;
  /** Pagada: fecha y forma del último cobro. */
  paid?: { at: string; method: string | null } | null;
}): string {
  const i = args.invoice;
  const brand =
    args.brandColor && /^#[0-9a-f]{6}$/i.test(args.brandColor) ? args.brandColor : '#111111';
  const logo =
    args.logo && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(args.logo)
      ? args.logo
      : null;
  const issuer = args.issuer;
  const isReceipt = i.kind === 'deposit_receipt';
  const isRectification = i.invoiceType.startsWith('R');
  const title = invoiceDocTitle(i);
  const c = args.customer;
  const customerName = c
    ? c.customerType === 'business'
      ? (c.companyName ?? 'Empresa')
      : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre'
    : 'Cliente no identificado';

  const itemsRows = i.items
    .map((it) => {
      const category = it.taxCategory as InvoiceTaxCategory;
      const vat =
        category === 'S1'
          ? `${it.taxRate.toLocaleString('es-ES')} %`
          : isExemptCategory(category)
            ? 'Exenta'
            : 'No sujeta';
      const period =
        it.periodStart && it.periodEnd
          ? `<div class="period">Del ${day(it.periodStart)} al ${day(it.periodEnd)}</div>`
          : '';
      return `
        <tr>
          <td>${escapeHtml(it.description)}${period}</td>
          <td class="num">${it.quantity.toLocaleString('es-ES')}</td>
          <td class="num">${eur(it.unitPrice)}</td>
          <td class="num">${vat}</td>
          <td class="num">${eur(it.total - it.taxAmount)}</td>
        </tr>`;
    })
    .join('');

  const b = invoiceBreakdown(i.items);
  const breakdownRows = [
    ...b.taxed.flatMap((t) => [
      `<div class="row"><span>Base imponible ${t.rate.toLocaleString('es-ES')} %</span><span class="num">${eur(t.base)}</span></div>`,
      `<div class="row"><span>IVA ${t.rate.toLocaleString('es-ES')} %</span><span class="num">${eur(t.tax)}</span></div>`,
    ]),
    ...(b.exempt !== 0
      ? [`<div class="row"><span>Exento</span><span class="num">${eur(b.exempt)}</span></div>`]
      : []),
    ...(b.notSubject !== 0
      ? [
          `<div class="row"><span>No sujeto</span><span class="num">${eur(b.notSubject)}</span></div>`,
        ]
      : []),
  ].join('');

  // Mención legal de las líneas exentas o no sujetas (art. 6.1.j del
  // Reglamento de facturación): una vez por tipo fiscal presente.
  const legalNotes = [...new Set(i.items.map((it) => it.taxCategory as InvoiceTaxCategory))]
    .map((cat) => INVOICE_TAX_CATEGORY_LEGAL_TEXT[cat])
    .filter((t): t is string => Boolean(t));

  // Rectificativa: a qué factura rectifica, por qué y cómo (RD 1619/2012, art. 15).
  const rectification = isRectification
    ? `<div class="box">
    <strong>Rectifica la factura ${escapeHtml(i.rectifiesInvoiceNumber ?? '—')}${
      i.rectifiesInvoiceDate ? ` de ${day(i.rectifiesInvoiceDate)}` : ''
    }</strong>
    <div class="row">Motivo: ${escapeHtml(i.rectificationReason ?? '—')}</div>
    <div class="row">Tipo: ${i.invoiceType} · ${RECTIFICATION_LABELS[i.invoiceType] ?? ''} · ${
      i.correctionMethod === 'by_substitution' ? 'por sustitución' : 'por diferencias'
    }</div>
  </div>`
    : '';

  const period =
    i.periodStart && i.periodEnd
      ? `<div class="meta">Periodo: del ${day(i.periodStart)} al ${day(i.periodEnd)}</div>`
      : '';
  const due =
    i.dueDate && i.total > 0 && !isRectification
      ? `<div class="meta">Vencimiento: ${day(i.dueDate)}</div>`
      : '';

  const stamp = args.paid
    ? `<div class="stamp">PAGADA<small>${day(args.paid.at)}${
        args.paid.method && METHOD_WORDS[args.paid.method]
          ? ` · ${METHOD_WORDS[args.paid.method]}`
          : ''
      }</small></div>`
    : '';
  const howToPay =
    args.payment && !args.paid && (i.status === 'issued' || i.status === 'overdue') && i.total > 0
      ? `<div class="box pay"><strong>Forma de pago</strong>${paymentLines(
          args.payment,
          i.invoiceNumber,
        )
          .map((l) => `<div class="row">${escapeHtml(l)}</div>`)
          .join('')}</div>`
      : '';

  // La justificación de una simplificada se guarda delante de las notas.
  const notes = (i.notes ?? '').replace(/^\[F2:[a-z_]+\]\s*/, '').trim();

  // QR tributario, solo en los registros de Veri*Factu: al principio de la
  // factura y centrado, con «QR tributario:» encima y la frase debajo, del
  // tamaño del resto de datos (especificación técnica del QR de la AEAT, apdo. 3).
  const qr =
    !isReceipt &&
    i.hash &&
    i.qrCodeUrl &&
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(i.qrCodeUrl)
      ? `<div class="vf">
    <div class="vf-text">${VERIFACTU_QR_LABEL}</div>
    <img class="vf-qr" src="${i.qrCodeUrl}" alt="QR tributario" />
    <div class="vf-text">${VERIFACTU_INVOICE_LEGEND}</div>
  </div>`
      : '';

  const customerBlock = c
    ? `
    <div class="row">${escapeHtml(customerName)}</div>
    ${c.documentNumber ? `<div class="row">${escapeHtml(c.documentType ?? 'Documento')}: ${escapeHtml(c.documentNumber)}</div>` : ''}
    ${c.address ? `<div class="row">${escapeHtml(c.address)}</div>` : ''}
    ${
      c.postalCode || c.city
        ? `<div class="row">${escapeHtml([c.postalCode, c.city].filter(Boolean).join(' '))} (${escapeHtml(c.country)})</div>`
        : ''
    }
    ${c.email ? `<div class="row">${escapeHtml(c.email)}</div>` : ''}`
    : `<div class="row">${escapeHtml(customerName)}</div>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${title} ${escapeHtml(i.invoiceNumber)}</title>
<style>
  body { font-family: -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif; color: #111; font-size: 10.5pt; line-height: 1.4; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24pt; margin-bottom: 20pt; }
  h1 { font-size: 20pt; margin: 0 0 6pt; color: ${brand}; }
  .logo { max-height: 48pt; max-width: 160pt; margin-bottom: 6pt; }
  .stamp { display: inline-block; margin-top: 8pt; border: 2.5pt solid #15803d; color: #15803d; border-radius: 6pt; padding: 4pt 10pt; font-weight: 700; font-size: 14pt; letter-spacing: 2pt; transform: rotate(-4deg); }
  .stamp small { display: block; font-size: 8pt; letter-spacing: 0; font-weight: 500; text-align: center; }
  .box.pay { margin-top: 16pt; }
  .meta { color: #555; font-size: 9.5pt; }
  .issuer { text-align: right; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 16pt; margin-bottom: 16pt; }
  .party, .box { border: 1px solid #e2e2e2; border-radius: 6pt; padding: 10pt 12pt; background: #fafafa; }
  .box { margin-bottom: 16pt; }
  .party strong { font-size: 10pt; text-transform: uppercase; color: #555; }
  .party .row, .box .row { margin-top: 4pt; font-size: 9.5pt; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th, table.items td { border-bottom: 1px solid #ddd; padding: 6pt 4pt; vertical-align: top; }
  table.items th { background: #f4f4f4; text-align: left; font-size: 8.5pt; text-transform: uppercase; border-bottom: 2px solid ${brand}; }
  table.items th.num { text-align: right; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .period { color: #777; font-size: 8.5pt; }
  .totals { margin-top: 14pt; margin-left: auto; width: 280pt; }
  .totals .row { display: flex; justify-content: space-between; padding: 3pt 8pt; }
  .totals .row.grand { font-size: 12.5pt; font-weight: 600; border-top: 2px solid #111; margin-top: 4pt; padding-top: 6pt; }
  header.with-qr { display: grid; grid-template-columns: 1fr auto 1fr; gap: 16pt; }
  .vf { text-align: center; width: 48mm; }
  .vf-text { font-size: 10.5pt; color: #111; line-height: 1.25; }
  .vf-qr { display: block; width: 34mm; height: 34mm; margin: 1.5mm auto; padding: 3mm; background: #fff; }
  .verifactu { margin-top: 26pt; display: flex; gap: 18pt; align-items: flex-end; border-top: 1px solid #ddd; padding-top: 14pt; }
  .verifactu .legal { font-size: 8.5pt; color: #666; }
  .verifactu .hash { font-family: monospace; font-size: 7.5pt; color: #888; word-break: break-all; }
  .notes { margin-top: 14pt; font-size: 9pt; color: #444; }
</style>
</head>
<body>
<header${qr ? ' class="with-qr"' : ''}>
  <div>
    <h1>${title}</h1>
    <div class="meta">N.º <strong>${escapeHtml(i.invoiceNumber)}</strong></div>
    <div class="meta">Fecha de emisión: ${day(i.issueDate)}</div>
    ${due}
    ${period}
  </div>
  ${qr}
  <div class="issuer">
    ${logo ? `<img class="logo" src="${logo}" alt="" /><br />` : ''}
    <strong>${escapeHtml(issuer.name)}</strong>
    ${issuer.billingEmail ? `<div class="meta">${escapeHtml(issuer.billingEmail)}</div>` : ''}
    ${stamp}
  </div>
</header>

${rectification}

<div class="parties">
  <div class="party">
    <strong>Emisor</strong>
    <div class="row">${escapeHtml(issuer.legalName || issuer.name)}</div>
    ${issuer.taxId ? `<div class="row">NIF: ${escapeHtml(issuer.taxId)}</div>` : ''}
    ${issuer.address ? `<div class="row">${escapeHtml(issuer.address)}</div>` : ''}
    ${issuer.managedBy ? `<div class="row">Gestionado por ${escapeHtml(issuer.managedBy)}</div>` : ''}
  </div>
  <div class="party">
    <strong>Cliente</strong>
    ${customerBlock}
  </div>
</div>

<table class="items">
  <thead>
    <tr>
      <th>Concepto</th>
      <th class="num">Cantidad</th>
      <th class="num">Precio</th>
      <th class="num">IVA</th>
      <th class="num">Importe</th>
    </tr>
  </thead>
  <tbody>${itemsRows}</tbody>
</table>

<div class="totals">
  ${breakdownRows}
  <div class="row grand"><span>Total</span><span class="num">${eur(i.total)}</span></div>
  ${
    i.withholdingAmount > 0
      ? `<div class="row"><span>Retención IRPF (${i.withholdingPct.toLocaleString('es-ES')} %)</span><span class="num">−${eur(i.withholdingAmount)}</span></div>
  <div class="row grand"><span>Total a pagar</span><span class="num">${eur(i.amountDue)}</span></div>`
      : ''
  }
</div>

${howToPay}

${
  isReceipt
    ? `<div class="verifactu"><div class="legal">Fianza en garantía del contrato: no es una factura ni una operación sujeta a IVA. Se devuelve al terminar el contrato, descontando lo que proceda.</div></div>`
    : i.hash
      ? // Solo si es un registro de Veri*Factu (el QR va arriba); sin él, la
        // factura no se ha enviado a la AEAT y no lleva nada de esto.
        `<div class="verifactu">
  <div class="legal">
    <span class="hash">Huella del registro: ${escapeHtml(i.hash)}</span>
    ${i.aeatCsv ? `<br /><span class="hash">CSV de la AEAT: ${escapeHtml(i.aeatCsv)}</span>` : ''}
  </div>
</div>`
      : ''
}

${
  !isReceipt && legalNotes.length > 0
    ? `<div class="notes">${legalNotes.map(escapeHtml).join('<br />')}</div>`
    : ''
}
${notes ? `<div class="notes"><strong>Notas:</strong> ${escapeHtml(notes)}</div>` : ''}
</body>
</html>`;
}
