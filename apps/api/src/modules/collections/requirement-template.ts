/**
 * Plantilla PURA del requerimiento fehaciente de pago (sin Puppeteer). Vive
 * aparte del service para poder testearla por unit sin lanzar el navegador.
 *
 * Dice lo que dice la condición 12 del contrato: si no paga en el plazo (no
 * inferior a 15 días desde que lo recibe), el contrato queda resuelto; tiene
 * que retirar sus bienes y, si no lo hace, se trasladan con inventario a un
 * lugar de custodia a su cargo, y solo se dispone de ellos por los cauces
 * legales.
 */

export interface RequirementInvoiceLine {
  number: string;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  pendingCents: number;
}

export interface RequirementData {
  /** El arrendador: la empresa (razón social) o el propietario del local. */
  issuer: {
    name: string;
    taxId: string | null;
    address: string | null;
    /** Quien gestiona en nombre del propietario (su nombre comercial). */
    managedBy: string | null;
  };
  noticeDays: number;
  clauseRef: string | null;
  customer: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    documentType: string | null;
    documentNumber: string | null;
    address: string | null;
    city: string | null;
    postalCode: string | null;
  } | null;
  unitCode: string | null;
  contractNumber: string | null;
  facility: {
    name: string;
    address: string | null;
    city: string | null;
    postalCode: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
  } | null;
  lines: RequirementInvoiceLine[];
  debtCents: number;
  /** Cómo puede pagar. */
  payment: { iban: string | null; portalUrl: string | null };
  /** Fecha del documento, ya en la zona del negocio («11 de noviembre de 2026»). */
  today: string;
}

function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(cents: number): string {
  return `${(cents / 100).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

/** `2026-11-11` → `11/11/2026`. */
function day(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : iso;
}

export function requirementCustomerName(c: RequirementData['customer']): string {
  if (!c) return 'Cliente';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/** Renderiza el HTML del requerimiento (Puppeteer lo convierte a PDF). */
export function renderRequirementHtml(d: RequirementData): string {
  const c = d.customer;
  const customerName = requirementCustomerName(c);
  const customerDoc =
    c?.documentNumber != null
      ? `${c.documentType ? `${esc(c.documentType.toUpperCase())} ` : ''}${esc(c.documentNumber)}`
      : '';
  const customerAddress = [c?.address, [c?.postalCode, c?.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .map(esc)
    .join('<br>');
  const facilityAddress = [
    d.facility?.address,
    [d.facility?.postalCode, d.facility?.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  const clause = d.clauseRef ? esc(d.clauseRef) : 'condición 12 de las condiciones del contrato';

  const rows = d.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.number)}</td><td>${esc(day(l.issueDate))}</td><td>${esc(
          day(l.dueDate),
        )}</td><td class="r">${money(l.totalCents)}</td><td class="r">${money(
          l.pendingCents,
        )}</td></tr>`,
    )
    .join('');
  const ways = [
    d.payment.iban
      ? `por transferencia a la cuenta <strong>${esc(d.payment.iban)}</strong>, indicando el número de factura`
      : null,
    d.payment.portalUrl
      ? `desde su área de clientes: <strong>${esc(d.payment.portalUrl)}</strong>`
      : null,
    'o en el propio local',
  ].filter(Boolean);

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; line-height: 1.5; }
    .head { display: flex; justify-content: space-between; margin-bottom: 28px; }
    .op { font-weight: bold; font-size: 14px; }
    .muted { color: #555; }
    .box { border: 1px solid #ccc; border-radius: 6px; padding: 10px 12px; margin: 14px 0; }
    h1 { font-size: 16px; text-transform: uppercase; letter-spacing: .5px; margin: 18px 0 6px; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; }
    th { background: #f4f4f5; font-size: 11px; text-transform: uppercase; }
    td.r, th.r { text-align: right; }
    .total { font-weight: bold; font-size: 13px; }
    .warn { background: #fff7ed; border: 1px solid #fdba74; border-radius: 6px; padding: 10px 12px; margin: 14px 0; }
    .sign { margin-top: 40px; }
    .foot { margin-top: 40px; font-size: 10px; color: #777; border-top: 1px solid #eee; padding-top: 8px; }
  </style></head><body>
    <div class="head">
      <div>
        <div class="op">${esc(d.issuer.name)}</div>
        ${d.issuer.taxId ? `<div class="muted">NIF: ${esc(d.issuer.taxId)}</div>` : ''}
        ${d.issuer.address ? `<div class="muted">${esc(d.issuer.address)}</div>` : ''}
        ${d.issuer.managedBy ? `<div class="muted">Gestionado por ${esc(d.issuer.managedBy)}</div>` : ''}
        ${d.facility?.name ? `<div class="muted">${esc(d.facility.name)}${facilityAddress ? ` · ${facilityAddress}` : ''}</div>` : ''}
        ${d.facility?.contactPhone ? `<div class="muted">Tel.: ${esc(d.facility.contactPhone)}</div>` : ''}
        ${d.facility?.contactEmail ? `<div class="muted">${esc(d.facility.contactEmail)}</div>` : ''}
      </div>
      <div class="muted" style="text-align:right">${esc(d.today)}</div>
    </div>

    <div class="box">
      <strong>${esc(customerName)}</strong>${customerDoc ? `<br><span class="muted">${customerDoc}</span>` : ''}
      ${customerAddress ? `<br>${customerAddress}` : ''}
    </div>

    <h1>Requerimiento fehaciente de pago</h1>
    <p>Muy Sr./Sra. nuestro/a:</p>
    <p>Le comunicamos que mantiene una <strong>deuda vencida y pendiente de pago</strong>
    derivada del contrato de alquiler del trastero${d.unitCode ? ` <strong>${esc(d.unitCode)}</strong>` : ''}${
      d.facility?.name ? ` del local ${esc(d.facility.name)}` : ''
    }${d.contractNumber ? ` (contrato nº ${esc(d.contractNumber)})` : ''}, con este detalle:</p>

    <table>
      <thead><tr><th>Factura</th><th>Fecha</th><th>Vencimiento</th><th class="r">Importe</th><th class="r">Pendiente</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">Sin facturas vencidas.</td></tr>'}</tbody>
      <tfoot><tr class="total"><td colspan="4" class="r">Total adeudado</td><td class="r">${money(d.debtCents)}</td></tr></tfoot>
    </table>

    <p>Por este escrito le <strong>requerimos para que, en el plazo de ${d.noticeDays} días
    naturales desde que lo reciba</strong>, pague la totalidad de la deuda ${ways.join(', ')}.</p>

    <div class="warn">
      <strong>Si no paga en ese plazo</strong>, conforme a lo pactado en el contrato (${clause}):
      <ul>
        <li>el <strong>contrato quedará resuelto</strong>, sin perjuicio de reclamarle las
        cantidades adeudadas por la vía que corresponda;</li>
        <li>deberá <strong>retirar sus bienes</strong> del trastero: puede pedirnos una cita
        para hacerlo;</li>
        <li>si no los retira, se <strong>trasladarán con inventario</strong> a un lugar de
        custodia, donde podrá recuperarlos; los gastos de traslado y custodia serán a su
        cargo;</li>
        <li>solo se dispondrá de ellos por los <strong>cauces legales</strong>.</li>
      </ul>
      Mientras la deuda siga pendiente, el acceso al trastero puede permanecer suspendido.
    </div>

    <p>Si ya ha pagado, le rogamos que no tenga en cuenta este requerimiento y nos envíe el
    justificante.</p>

    <div class="sign">
      <p>Atentamente,</p>
      <p><strong>${esc(d.issuer.name)}</strong></p>
    </div>

    <div class="foot">
      Documento generado el ${esc(d.today)}. Envíelo por un medio que deje constancia de la
      entrega (burofax con acuse de recibo y certificación de texto) y conserve el justificante.
    </div>
  </body></html>`;
}
