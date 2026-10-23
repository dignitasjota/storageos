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
}

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
</body></html>`;
}
