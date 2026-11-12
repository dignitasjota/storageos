/**
 * Plantillas PURAS de los documentos de un expediente de impago (sin
 * Puppeteer), para probarlas sin lanzar el navegador:
 *   - el acta del traslado y la custodia de los bienes (con el inventario);
 *   - el dossier del expediente (todo lo que lo acredita, en un PDF);
 *   - el borrador de la petición de juicio monitorio (art. 812 y siguientes de
 *     la Ley de Enjuiciamiento Civil), para revisarlo con un abogado.
 */

export interface CaseDocParty {
  name: string;
  taxId: string | null;
  address: string | null;
  /** Quien gestiona en nombre del propietario (su nombre comercial). */
  managedBy: string | null;
}

export interface CaseDocCustomer {
  name: string;
  /** «DNI 12345678Z». */
  document: string | null;
  address: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
}

export interface CaseDocInvoice {
  number: string;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  pendingCents: number;
}

export interface CaseDocData {
  issuer: CaseDocParty;
  customer: CaseDocCustomer;
  unitCode: string | null;
  facility: { name: string; address: string | null; city: string | null } | null;
  contract: {
    number: string | null;
    /** «3 de marzo de 2026». */
    signedAt: string | null;
    signedBy: string | null;
  };
  invoices: CaseDocInvoice[];
  debtCents: number;
  notice: {
    sentAt: string | null;
    tracking: string | null;
    receivedAt: string | null;
    deadline: string | null;
  };
  /** Fecha del documento («11 de noviembre de 2026»). */
  today: string;
  /** Lugar del documento (la ciudad del local). */
  place: string | null;
}

export interface CustodyActData extends CaseDocData {
  /** Una línea por bien o lote. */
  items: string[];
  witnesses: string | null;
  custodyLocation: string | null;
  movedAt: string | null;
  contractResolvedAt: string | null;
  /** Desde cuándo se pueden dar por abandonados (8 semanas de custodia). */
  abandonmentFrom: string | null;
}

export interface DossierData extends CaseDocData {
  statusLabel: string;
  openedAt: string;
  timeline: { date: string; label: string; by: string | null; detail: string | null }[];
  communications: { date: string; channel: string; subject: string; status: string }[];
  payments: {
    date: string;
    invoiceNumber: string;
    amount: number;
    method: string;
    status: string;
  }[];
  files: { label: string; date: string; imageDataUri: string | null }[];
}

export function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function money(cents: number): string {
  return `${(cents / 100).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

/** `2026-11-11` → `11/11/2026`. */
function day(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : iso;
}

const STYLE = `<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; line-height: 1.5; }
  h1 { font-size: 16px; text-transform: uppercase; letter-spacing: .5px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 18px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
  .muted { color: #555; }
  .box { border: 1px solid #ccc; border-radius: 6px; padding: 10px 12px; margin: 10px 0; }
  .grid { display: flex; gap: 12px; }
  .grid > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; }
  th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-size: 10px; text-transform: uppercase; }
  td.r, th.r { text-align: right; white-space: nowrap; }
  .total td { font-weight: bold; border-top: 2px solid #111; }
  .draft { border: 2px dashed #b45309; background: #fffbeb; color: #78350f; padding: 8px 10px; border-radius: 6px; margin-bottom: 14px; }
  .signatures { display: flex; gap: 24px; margin-top: 40px; }
  .signature { flex: 1; border-top: 1px solid #111; padding-top: 4px; font-size: 11px; color: #555; height: 70px; }
  .photos { display: flex; flex-wrap: wrap; gap: 8px; }
  .photos figure { margin: 0; width: 48%; }
  .photos img { width: 100%; max-height: 260px; object-fit: contain; border: 1px solid #ddd; }
  .photos figcaption { font-size: 10px; color: #555; }
  ol li { margin-bottom: 6px; }
</style>`;

function partyBlock(title: string, p: CaseDocParty): string {
  return `<div class="box"><strong>${esc(title)}</strong><br>${esc(p.name)}${
    p.taxId ? `<br>NIF ${esc(p.taxId)}` : ''
  }${p.address ? `<br>${esc(p.address)}` : ''}${
    p.managedBy ? `<br><span class="muted">Gestionado por ${esc(p.managedBy)}</span>` : ''
  }</div>`;
}

function customerBlock(c: CaseDocCustomer, title = 'Inquilino'): string {
  return `<div class="box"><strong>${esc(title)}</strong><br>${esc(c.name)}${
    c.document ? `<br>${esc(c.document)}` : ''
  }${c.address ? `<br>${esc(c.address)}` : ''}${c.city ? `<br>${esc(c.city)}` : ''}</div>`;
}

function invoicesTable(d: CaseDocData): string {
  if (d.invoices.length === 0) return '<p class="muted">No hay facturas vencidas.</p>';
  const rows = d.invoices
    .map(
      (i) =>
        `<tr><td>${esc(i.number)}</td><td>${esc(day(i.issueDate))}</td><td>${esc(
          day(i.dueDate),
        )}</td><td class="r">${money(i.totalCents)}</td><td class="r">${money(
          i.pendingCents,
        )}</td></tr>`,
    )
    .join('');
  return `<table><tr><th>Factura</th><th>Fecha</th><th>Vencimiento</th><th class="r">Importe</th><th class="r">Pendiente</th></tr>${rows}<tr class="total"><td colspan="4">Total pendiente</td><td class="r">${money(
    d.debtCents,
  )}</td></tr></table>`;
}

function unitLine(d: CaseDocData): string {
  return [
    d.unitCode ? `trastero ${d.unitCode}` : null,
    d.facility
      ? `${d.facility.name}${d.facility.address ? ` (${d.facility.address}${d.facility.city ? `, ${d.facility.city}` : ''})` : ''}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Acta del traslado de los bienes a un lugar de custodia, con su inventario. */
export function renderCustodyActHtml(d: CustodyActData): string {
  const items = d.items
    .map((line, k) => `<tr><td class="r">${k + 1}</td><td>${esc(line)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">${STYLE}</head><body>
  <h1>Acta de traslado y custodia de bienes</h1>
  <div class="muted">${esc(unitLine(d))}</div>
  <div class="grid">${partyBlock('Arrendador', d.issuer)}${customerBlock(d.customer)}</div>
  <p>El contrato${d.contract.number ? ` ${esc(d.contract.number)}` : ''}${
    d.contract.signedAt ? `, firmado el ${esc(d.contract.signedAt)},` : ''
  } quedó resuelto por impago${
    d.contractResolvedAt ? ` el ${esc(d.contractResolvedAt)}` : ''
  }, una vez vencido sin pagar el plazo del requerimiento de pago${
    d.notice.receivedAt ? ` recibido el ${esc(d.notice.receivedAt)}` : ''
  }. Como el inquilino no retiró sus bienes, el ${esc(d.movedAt ?? d.today)} se trasladan con este inventario a:</p>
  <div class="box"><strong>Lugar de custodia</strong><br>${esc(d.custodyLocation ?? '—')}</div>
  <h2>Inventario</h2>
  <table><tr><th class="r">Nº</th><th>Bien o lote</th></tr>${items}</table>
  ${d.witnesses ? `<p><strong>Presentes en el traslado:</strong> ${esc(d.witnesses)}</p>` : ''}
  <p>Los bienes quedan en custodia a disposición del inquilino, a su cargo, para que los retire pidiendo cita. Si no los retira, pasadas ocho semanas desde el traslado${
    d.abandonmentFrom ? ` (el ${esc(d.abandonmentFrom)})` : ''
  } se podrán dar por abandonados y se dispondrá de ellos por los cauces legales; lo que se obtenga se aplicará a la deuda y lo que sobre será del inquilino.</p>
  <p>En ${esc(d.place ?? '________')}, a ${esc(d.today)}.</p>
  <div class="signatures">
    <div class="signature">Por el arrendador</div>
    <div class="signature">Testigo</div>
  </div>
</body></html>`;
}

/** Dossier: todo lo que acredita el impago y lo que se ha hecho, en un PDF. */
export function renderDossierHtml(d: DossierData): string {
  const timeline = d.timeline
    .map(
      (e) =>
        `<tr><td>${esc(e.date)}</td><td>${esc(e.label)}${
          e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''
        }</td><td>${esc(e.by ?? '')}</td></tr>`,
    )
    .join('');
  const comms = d.communications
    .map(
      (c) =>
        `<tr><td>${esc(c.date)}</td><td>${esc(c.channel)}</td><td>${esc(c.subject)}</td><td>${esc(
          c.status,
        )}</td></tr>`,
    )
    .join('');
  const payments = d.payments
    .map(
      (p) =>
        `<tr><td>${esc(p.date)}</td><td>${esc(p.invoiceNumber)}</td><td>${esc(p.method)}</td><td>${esc(
          p.status,
        )}</td><td class="r">${money(Math.round(p.amount * 100))}</td></tr>`,
    )
    .join('');
  const photos = d.files.filter((f) => f.imageDataUri);
  const others = d.files.filter((f) => !f.imageDataUri);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">${STYLE}</head><body>
  <h1>Dossier del expediente de impago</h1>
  <div class="muted">${esc(unitLine(d))} · Estado: ${esc(d.statusLabel)} · Abierto el ${esc(d.openedAt)} · Generado el ${esc(d.today)}</div>
  <div class="grid">${partyBlock('Arrendador', d.issuer)}${customerBlock(d.customer)}</div>
  ${
    d.customer.email || d.customer.phone
      ? `<p class="muted">Contacto del inquilino: ${esc([d.customer.email, d.customer.phone].filter(Boolean).join(' · '))}</p>`
      : ''
  }
  <h2>Contrato</h2>
  <p>${d.contract.number ? `Contrato ${esc(d.contract.number)}` : 'Contrato'}${
    d.contract.signedAt ? `, firmado el ${esc(d.contract.signedAt)}` : ', sin firma registrada'
  }${d.contract.signedBy ? ` por ${esc(d.contract.signedBy)}` : ''}.</p>
  <h2>Deuda</h2>
  ${invoicesTable(d)}
  <h2>Requerimiento de pago</h2>
  <p>${
    d.notice.sentAt
      ? `Enviado el ${esc(d.notice.sentAt)}${d.notice.tracking ? ` (envío ${esc(d.notice.tracking)})` : ''}${
          d.notice.receivedAt ? `, recibido el ${esc(d.notice.receivedAt)}` : ''
        }${d.notice.deadline ? `; el plazo para pagar vencía el ${esc(d.notice.deadline)}` : ''}.`
      : 'Aún no se ha enviado.'
  }</p>
  ${payments ? `<h2>Cobros y devoluciones</h2><table><tr><th>Fecha</th><th>Factura</th><th>Forma</th><th>Estado</th><th class="r">Importe</th></tr>${payments}</table>` : ''}
  <h2>Avisos enviados</h2>
  ${
    comms
      ? `<table><tr><th>Fecha</th><th>Canal</th><th>Asunto</th><th>Estado</th></tr>${comms}</table>`
      : '<p class="muted">Ningún aviso registrado.</p>'
  }
  <h2>Historial del expediente</h2>
  <table><tr><th>Fecha</th><th>Qué pasó</th><th>Quién</th></tr>${timeline}</table>
  ${
    others.length > 0
      ? `<h2>Documentos del expediente</h2><ul>${others
          .map((f) => `<li>${esc(f.label)} · ${esc(f.date)}</li>`)
          .join('')}</ul>`
      : ''
  }
  ${
    photos.length > 0
      ? `<h2>Fotos</h2><div class="photos">${photos
          .map(
            (f) =>
              `<figure><img src="${f.imageDataUri}" alt=""><figcaption>${esc(f.label)} · ${esc(
                f.date,
              )}</figcaption></figure>`,
          )
          .join('')}</div>`
      : ''
  }
</body></html>`;
}

/**
 * Borrador de la petición inicial de juicio monitorio (arts. 812 a 818 de la
 * Ley de Enjuiciamiento Civil). Lo presenta el arrendador en el juzgado de
 * primera instancia del domicilio del deudor (art. 813).
 */
export function renderMonitorioHtml(d: CaseDocData): string {
  const docs = [
    'Documento 1: el contrato firmado por el deudor.',
    'Documento 2: las facturas impagadas que se reclaman.',
    d.notice.sentAt
      ? `Documento 3: el requerimiento de pago enviado el ${d.notice.sentAt}${
          d.notice.tracking ? ` (envío ${d.notice.tracking})` : ''
        }${d.notice.receivedAt ? ` y el justificante de su recepción el ${d.notice.receivedAt}` : ''}.`
      : null,
  ].filter((x): x is string => !!x);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">${STYLE}</head><body>
  <div class="draft"><strong>Borrador.</strong> Revísalo con tu abogado antes de presentarlo. Para reclamar hasta 2.000 € no hace falta abogado ni procurador (art. 814.2 LEC); el formulario oficial está en la sede judicial electrónica.</div>
  <p><strong>AL JUZGADO DE PRIMERA INSTANCIA DE ${esc((d.customer.city ?? '________').toUpperCase())}</strong></p>
  <p>${esc(d.issuer.name)}${d.issuer.taxId ? `, con NIF ${esc(d.issuer.taxId)}` : ''}${
    d.issuer.address ? `, con domicilio en ${esc(d.issuer.address)}` : ''
  }, ante el Juzgado comparezco y, como mejor proceda en Derecho, DIGO:</p>
  <p>Que por medio de este escrito formulo <strong>PETICIÓN INICIAL DE PROCEDIMIENTO MONITORIO</strong> contra ${esc(
    d.customer.name,
  )}${d.customer.document ? `, con ${esc(d.customer.document)}` : ''}${
    d.customer.address
      ? `, con domicilio en ${esc(d.customer.address)}${d.customer.city ? `, ${esc(d.customer.city)}` : ''}`
      : ''
  }, en reclamación de <strong>${money(d.debtCents)}</strong>, con base en los siguientes</p>
  <h2>HECHOS</h2>
  <ol>
    <li>Las partes firmaron${d.contract.signedAt ? ` el ${esc(d.contract.signedAt)}` : ''} un contrato${
      d.contract.number ? ` (nº ${esc(d.contract.number)})` : ''
    } de alquiler del ${esc(unitLine(d) || 'trastero')}, por el que el deudor se obligó a pagar una cuota periódica.</li>
    <li>El deudor no ha pagado las facturas siguientes, que suman ${money(d.debtCents)}:${invoicesTable(d)}</li>
    <li>${
      d.notice.sentAt
        ? `Se le requirió de pago de forma fehaciente el ${esc(d.notice.sentAt)}${
            d.notice.tracking ? ` (envío ${esc(d.notice.tracking)})` : ''
          }${d.notice.receivedAt ? `, requerimiento que recibió el ${esc(d.notice.receivedAt)}` : ''}, sin que haya pagado.`
        : 'Se le ha reclamado el pago sin resultado.'
    }</li>
    <li>La deuda es dineraria, vencida, exigible y de cantidad determinada, y consta en los documentos que se acompañan (art. 812 LEC).</li>
  </ol>
  <h2>FUNDAMENTOS DE DERECHO</h2>
  <ol>
    <li>Procedimiento: arts. 812 a 818 de la Ley de Enjuiciamiento Civil.</li>
    <li>Competencia: el juzgado de primera instancia del domicilio del deudor (art. 813 LEC).</li>
    <li>Fondo: las obligaciones nacidas de los contratos tienen fuerza de ley entre las partes y deben cumplirse (arts. 1091, 1100 y 1101 del Código Civil).</li>
  </ol>
  <p>Por todo lo anterior, <strong>SUPLICO AL JUZGADO</strong> que tenga por presentado este escrito con los documentos que lo acompañan, admita la petición de procedimiento monitorio y requiera al deudor para que, en el plazo de veinte días, pague ${money(
    d.debtCents,
  )} o comparezca y alegue las razones por las que, a su entender, no debe todo o parte de esa cantidad, con el apercibimiento de que, si no lo hace, se despachará ejecución contra él.</p>
  <h2>DOCUMENTOS QUE SE ACOMPAÑAN</h2>
  <ul>${docs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  <p>En ${esc(d.place ?? '________')}, a ${esc(d.today)}.</p>
  <div class="signatures"><div class="signature">Firma del acreedor</div></div>
</body></html>`;
}
