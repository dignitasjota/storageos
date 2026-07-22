/**
 * Plantilla PURA del requerimiento fehaciente de pago (sin Puppeteer). Vive
 * aparte del service para poder testearla por unit sin lanzar el navegador.
 */

export interface RequirementInvoiceLine {
  number: string;
  issueDate: string;
  totalCents: number;
  pendingCents: number;
}

export interface RequirementData {
  tenant: {
    name: string;
    taxId: string | null;
    collectionsNoticeDays: number;
    collectionsClauseRef: string | null;
  };
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
      ? `${c.documentType ? `${esc(c.documentType)} ` : ''}${esc(c.documentNumber)}`
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
  const noticeDays = d.tenant.collectionsNoticeDays;
  const clauseRef = d.tenant.collectionsClauseRef;

  const rows = d.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.number)}</td><td>${esc(l.issueDate)}</td><td class="r">${money(
          l.totalCents,
        )}</td><td class="r">${money(l.pendingCents)}</td></tr>`,
    )
    .join('');

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
        <div class="op">${esc(d.tenant.name)}</div>
        ${d.tenant.taxId ? `<div class="muted">NIF/CIF: ${esc(d.tenant.taxId)}</div>` : ''}
        ${d.facility?.name ? `<div class="muted">${esc(d.facility.name)}</div>` : ''}
        ${facilityAddress ? `<div class="muted">${facilityAddress}</div>` : ''}
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
    <p>Por la presente le comunicamos que, según nuestros registros, mantiene una
    <strong>deuda vencida y pendiente de pago</strong> derivada del contrato de arrendamiento
    del trastero${d.unitCode ? ` <strong>${esc(d.unitCode)}</strong>` : ''}${
      d.facility?.name ? ` del local ${esc(d.facility.name)}` : ''
    }${d.contractNumber ? ` (contrato nº ${esc(d.contractNumber)})` : ''}, con el siguiente detalle:</p>

    <table>
      <thead><tr><th>Factura</th><th>Fecha</th><th class="r">Importe</th><th class="r">Pendiente</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">Sin facturas pendientes registradas.</td></tr>'}</tbody>
      <tfoot><tr class="total"><td colspan="3" class="r">Total adeudado</td><td class="r">${money(d.debtCents)}</td></tr></tfoot>
    </table>

    <p>Mediante este escrito le <strong>requerimos formalmente para que, en el plazo de
    ${noticeDays} días naturales</strong> desde la recepción del presente, proceda a
    <strong>saldar la totalidad de la deuda</strong> por cualquiera de los medios de pago
    habilitados.</p>

    <div class="warn">
      <strong>Advertencia.</strong> De no atender este requerimiento en el plazo indicado, y de
      conformidad con lo pactado en el contrato de arrendamiento${
        clauseRef ? ` (${esc(clauseRef)})` : ''
      }, esta parte podrá adoptar las medidas previstas en el mismo, incluida la
      <strong>restricción del acceso al trastero</strong> y, en su caso, la
      <strong>disposición del contenido</strong> para resarcirse de la deuda, todo ello sin
      perjuicio de la reclamación de las cantidades adeudadas por la vía que corresponda.
    </div>

    <p>Si ya ha efectuado el pago, le rogamos considere este requerimiento por no puesto y nos
    remita el justificante correspondiente.</p>

    <div class="sign">
      <p>Atentamente,</p>
      <p><strong>${esc(d.tenant.name)}</strong></p>
    </div>

    <div class="foot">
      Documento generado el ${esc(d.today)}. Este requerimiento no constituye asesoramiento
      jurídico; su validez y efectos dependen de lo pactado en el contrato y de la normativa
      aplicable. Conserve el acuse de recibo del envío (burofax) como prueba.
    </div>
  </body></html>`;
}
