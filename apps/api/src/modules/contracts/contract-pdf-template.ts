import { termsHash } from './contract-terms';

export interface ContractPdfSignature {
  signerName: string;
  signerEmail: string | null;
  method: string;
  signatureImage: string | null;
  typedSignature: string | null;
  documentHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  channel: string;
  signedAt: Date;
}

export interface ContractPdfInput {
  contractNumber: string;
  housing: boolean;
  status: string;
  /** Texto firmado (congelado) o, en borrador, el que verá el inquilino. */
  termsText: string;
  /** true = texto congelado al firmar. */
  termsFrozen: boolean;
  signedAt: Date | null;
  signatures: ContractPdfSignature[];
  /** Condiciones generales de contratación aceptadas (versión exacta). */
  generalTerms?: {
    title: string;
    version: number;
    contentHash: string;
    acceptedAt: Date;
    channel: string;
  }[];
  tenantName: string;
  generatedAt: Date;
}

const CHANNEL_LABEL: Record<string, string> = {
  remote: 'Enlace enviado al inquilino',
  in_person: 'En el local (firma asistida)',
  portal: 'Área de clientes',
  self_service: 'Reserva online',
};

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** Fecha y hora en España (`23/10/2026 18:04`). */
function madrid(d: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** Solo imágenes PNG/JPEG en base64: nada que el navegador pueda ejecutar. */
function safeImage(src: string | null): string | null {
  if (!src) return null;
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null;
}

function signatureBlock(sig: ContractPdfSignature, termsText: string, frozen: boolean): string {
  const image = sig.method === 'drawn' ? safeImage(sig.signatureImage) : null;
  const mark = image
    ? `<img src="${image}" alt="Firma" style="max-height:70pt;max-width:220pt" />`
    : `<div class="typed">${esc(sig.typedSignature || sig.signerName)}</div>`;
  const matches = frozen ? termsHash(termsText) === sig.documentHash : null;
  const rows: [string, string][] = [
    ['Firmante', sig.signerName],
    ...(sig.signerEmail ? ([['Email', sig.signerEmail]] as [string, string][]) : []),
    ['Fecha y hora', `${madrid(sig.signedAt)} (hora de España)`],
    ['Forma de firma', sig.method === 'drawn' ? 'Firma dibujada' : 'Nombre escrito'],
    ['Canal', CHANNEL_LABEL[sig.channel] ?? sig.channel],
    ...(sig.ipAddress ? ([['Dirección IP', sig.ipAddress]] as [string, string][]) : []),
    ...(sig.userAgent ? ([['Navegador', sig.userAgent.slice(0, 200)]] as [string, string][]) : []),
    ['Huella SHA-256', sig.documentHash],
  ];
  return `<div class="sig">
  <div class="mark">${mark}</div>
  <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
  ${
    matches === null
      ? ''
      : matches
        ? '<p class="ok">✓ La huella coincide con el texto de este documento: es exactamente lo que se firmó.</p>'
        : '<p class="ko">✗ La huella no coincide con el texto de este documento.</p>'
  }
</div>`;
}

/**
 * HTML del PDF del contrato: el texto firmado (el mismo cuya huella se guardó)
 * y, si está firmado, la firma con su evidencia (firmante, fecha, canal, IP,
 * navegador y huella). Función pura: se prueba sin Puppeteer.
 */
export function renderContractHtml(input: ContractPdfInput): string {
  const title = input.housing
    ? 'Contrato de arrendamiento de vivienda'
    : 'Contrato de alquiler de trastero';
  let evidence: string;
  if (input.status === 'draft') {
    evidence =
      '<div class="notice">Borrador pendiente de firma. Este texto puede cambiar hasta que el inquilino lo firme.</div>';
  } else if (input.signatures.length > 0) {
    evidence = `<h2>Firma electrónica</h2>
<p class="small">Firma electrónica simple (art. 25 del Reglamento eIDAS y Ley 6/2020). La huella identifica el texto exacto que se firmó: cualquier cambio en el texto daría otra huella.</p>
${input.signatures.map((s) => signatureBlock(s, input.termsText, input.termsFrozen)).join('\n')}`;
  } else {
    evidence = `<div class="notice">Contrato activado${input.signedAt ? ` el ${esc(madrid(input.signedAt))}` : ''} sin firma electrónica en TrasterOS (firmado en papel o importado de otro sistema).</div>`;
  }

  const terms = input.generalTerms ?? [];
  if (terms.length > 0) {
    evidence += `
<h2>Condiciones generales de contratación</h2>
${terms
  .map(
    (t) =>
      `<p class="small">Aceptadas el ${esc(madrid(t.acceptedAt))} (${esc(
        t.channel === 'in_person' ? 'en el local' : 'en la web, antes de pagar',
      )}): «${esc(t.title)}», versión ${t.version}. Huella SHA-256 del texto aceptado: ${esc(t.contentHash)}</p>`,
  )
  .join('\n')}`;
  }

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Contrato ${esc(input.contractNumber)}</title>
<style>
  body { font-family: -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif; color: #111; font-size: 10.5pt; line-height: 1.45; }
  h1 { font-size: 20pt; margin: 0 0 4pt 0; }
  h2 { font-size: 13pt; margin: 20pt 0 6pt 0; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
  .meta { color: #666; font-size: 9.5pt; margin-bottom: 14pt; }
  .terms { white-space: pre-wrap; border: 1px solid #e2e2e2; border-radius: 6pt; padding: 12pt; background: #fafafa; }
  .sig { border: 1px solid #e2e2e2; border-radius: 6pt; padding: 10pt 12pt; margin-top: 8pt; page-break-inside: avoid; }
  .mark { border-bottom: 1px solid #444; padding-bottom: 4pt; margin-bottom: 8pt; min-height: 40pt; }
  .typed { font-family: "Brush Script MT", "Segoe Script", cursive; font-size: 22pt; }
  dl { display: grid; grid-template-columns: 110pt 1fr; gap: 3pt 8pt; margin: 0; font-size: 9pt; }
  dt { color: #666; }
  dd { margin: 0; word-break: break-all; }
  .small { color: #666; font-size: 9pt; }
  .ok { color: #166534; font-size: 9pt; margin: 8pt 0 0; }
  .ko { color: #b91c1c; font-size: 9pt; margin: 8pt 0 0; }
  .notice { margin-top: 16pt; border: 1px solid #f59e0b; background: #fffbeb; border-radius: 6pt; padding: 8pt 10pt; font-size: 9.5pt; }
  .footer { margin-top: 28pt; font-size: 8.5pt; color: #888; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">N.º ${esc(input.contractNumber)}${input.signedAt && input.status !== 'draft' ? ` · Firmado el ${esc(madrid(input.signedAt))}` : ''}</div>
<div class="terms">${esc(input.termsText)}</div>
${evidence}
<div class="footer">${esc(input.tenantName)} · Documento generado el ${esc(madrid(input.generatedAt))} con TrasterOS</div>
</body>
</html>`;
}
