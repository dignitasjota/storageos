import type { SepaMandateDocument } from '@storageos/shared';

/**
 * HTML del mandato firmado (para el PDF): el documento, la firma y la
 * constancia (quién, cuándo, desde dónde y la huella). Función pura.
 */
export interface MandateEvidence {
  signerName: string;
  method: string;
  signatureImage: string | null;
  typedSignature: string | null;
  signedAt: Date;
  ip: string | null;
  userAgent: string | null;
  documentHash: string;
  /**
   * Solo para el acreedor (prueba ante una reclamación del deudor): la cuenta
   * completa y a qué email se envió el enlace de firma. No forma parte del
   * texto firmado.
   */
  annex?: { iban: string; signingLinkSentTo?: string | null; signerAccount?: string | null };
}

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function annexHtml(annex: MandateEvidence['annex']): string {
  if (!annex) return '';
  const iban = annex.iban.replace(/(.{4})/g, '$1 ').trim();
  return `<div class="ev" style="border-top:1px solid #ccc;padding-top:8px">
<div><strong>Anexo para el acreedor</strong> (no forma parte del documento firmado)</div>
<div>Cuenta del deudor (IBAN completo): ${esc(iban)}</div>
${annex.signingLinkSentTo ? `<div>Enlace de firma enviado a: ${esc(annex.signingLinkSentTo)}</div>` : ''}
${annex.signerAccount ? `<div>Firmado con la cuenta de usuario: ${esc(annex.signerAccount)}</div>` : ''}
<div>La huella se calcula sobre el texto firmado seguido de «IBAN: » y esta cuenta.</div>
</div>`;
}

export function renderMandateHtml(doc: SepaMandateDocument, ev: MandateEvidence): string {
  const rows = doc.fields
    .map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`)
    .join('');
  const clauses = doc.clauses.map((c) => `<p>${esc(c)}</p>`).join('');
  const signature =
    ev.method === 'drawn' && ev.signatureImage?.startsWith('data:image/')
      ? `<img src="${esc(ev.signatureImage)}" alt="Firma" style="max-height:90px">`
      : `<span style="font-family:'Brush Script MT',cursive;font-size:28px">${esc(ev.typedSignature ?? '')}</span>`;
  const when = new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'long',
    timeStyle: 'medium',
    timeZone: 'Europe/Madrid',
  }).format(ev.signedAt);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:32px}
h1{font-size:17px;margin:0 0 16px}
table{width:100%;border-collapse:collapse;margin-bottom:16px}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}
th{width:38%;background:#f5f5f5;font-weight:600}
.sig{border:1px solid #ccc;padding:12px;margin-top:16px}
.ev{font-size:10px;color:#555;margin-top:16px;word-break:break-all}
</style></head><body>
<h1>${esc(doc.title)}</h1>
<table>${rows}</table>
${clauses}
<div class="sig"><div><strong>Firma del deudor:</strong> ${esc(ev.signerName)}</div><div style="margin-top:8px">${signature}</div></div>
<div class="ev">
<div>Firmado electrónicamente el ${esc(when)} (hora de Madrid), ${ev.method === 'drawn' ? 'con firma dibujada' : 'con firma escrita'}.</div>
${ev.ip ? `<div>Dirección IP: ${esc(ev.ip)}</div>` : ''}
${ev.userAgent ? `<div>Navegador: ${esc(ev.userAgent)}</div>` : ''}
<div>Huella del documento (SHA-256): ${esc(ev.documentHash)}</div>
</div>
${annexHtml(ev.annex)}
</body></html>`;
}

/**
 * Vuelve a armar el documento desde el texto guardado (el que se firmó), para
 * el PDF: título, «campo: valor» y las cláusulas.
 */
export function parseStoredDocument(text: string): SepaMandateDocument {
  const [title = '', ...rest] = text.split('\n');
  const blank = rest.indexOf('', 1);
  const fieldLines = rest.slice(1, blank === -1 ? undefined : blank);
  const clauses = blank === -1 ? [] : rest.slice(blank + 1).filter(Boolean);
  return {
    title,
    fields: fieldLines.map((l) => {
      const i = l.indexOf(': ');
      return { label: l.slice(0, i), value: l.slice(i + 2) };
    }),
    clauses,
  };
}
