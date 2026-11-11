import { escapeHtml } from '../../common/tenant-email-layout';

import type { VerifactuDeclarationDto, VerifactuDeclarationItem } from '@storageos/shared';

function paragraphs(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
    .join('');
}

function rows(items: VerifactuDeclarationItem[]): string {
  return items
    .map(
      (item) => `
      <div class="item">
        <div class="label">${escapeHtml(item.label)}:</div>
        <div class="value">${paragraphs(item.value)}</div>
      </div>`,
    )
    .join('');
}

/**
 * HTML de la declaración responsable para el PDF: empieza por su título y cada
 * dato va con el texto que lo describe (art. 15 de la Orden HAC/1177/2024).
 */
export function renderDeclarationHtml(doc: VerifactuDeclarationDto): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(doc.title)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a; font-size: 11pt; line-height: 1.5; }
  h1 { font-size: 14pt; letter-spacing: 0.02em; margin: 0 0 18pt; text-align: center; }
  .item { margin-bottom: 12pt; page-break-inside: avoid; }
  .label { font-weight: 700; margin-bottom: 2pt; }
  .value p { margin: 0 0 6pt; }
  .contact { margin-top: 18pt; padding-top: 10pt; border-top: 1px solid #cbd5e1; font-size: 10pt; color: #334155; }
  .contact .item { margin-bottom: 6pt; }
</style>
</head>
<body>
  <h1>${escapeHtml(doc.title)}</h1>
  ${rows(doc.items)}
  <div class="contact">${rows(doc.contact)}</div>
</body>
</html>`;
}
