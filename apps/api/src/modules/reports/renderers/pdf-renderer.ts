import { Injectable, Logger } from '@nestjs/common';

import type { ReportResult } from '../generators/types';

type Browser = import('puppeteer').Browser;

/**
 * Renderiza un ReportResult a un PDF en bytes via Puppeteer + HTML+CSS.
 * Patron ESM-only dynamic import identico a InvoicePdfService / ContractPdfService.
 */
@Injectable()
export class PdfRenderer {
  private readonly logger = new Logger(PdfRenderer.name);
  private browserPromise: Promise<Browser> | null = null;

  async render(result: ReportResult): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(this.htmlFor(result), { waitUntil: 'domcontentloaded' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browserPromise) {
      const b = await this.browserPromise;
      await b.close().catch(() => undefined);
      this.browserPromise = null;
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        const { default: puppeteer } = await import('puppeteer');
        return puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
      })().catch((err) => {
        this.logger.error('Fallo al lanzar puppeteer', err);
        this.browserPromise = null;
        throw err;
      });
    }
    return this.browserPromise;
  }

  private htmlFor(r: ReportResult): string {
    const headers = r.columns
      .map((c) => `<th style="text-align:${c.align ?? 'left'}">${escape(c.label)}</th>`)
      .join('');
    const rows = r.rows
      .map((row) => {
        const tds = r.columns
          .map((c) => {
            const raw = row[c.key];
            const v = raw == null ? '' : formatValue(raw, c.type);
            return `<td style="text-align:${c.align ?? 'left'}">${escape(v)}</td>`;
          })
          .join('');
        return `<tr>${tds}</tr>`;
      })
      .join('');
    const summary = r.summary?.length
      ? `<div class="summary"><h3>Resumen</h3><ul>${r.summary
          .map((s) => `<li><span>${escape(s.label)}</span><strong>${escape(s.value)}</strong></li>`)
          .join('')}</ul></div>`
      : '';
    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<style>
  body { font-family: Inter, system-ui, sans-serif; color: #111; font-size: 11px; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .sub { color: #666; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  th { background: #f5f5f5; font-weight: 600; }
  .summary { margin-top: 20px; padding: 12px; background: #fafafa; border-radius: 6px; }
  .summary ul { list-style: none; padding: 0; margin: 0; }
  .summary li { display: flex; justify-content: space-between; padding: 4px 0; }
  .footer { margin-top: 24px; font-size: 9px; color: #999; }
</style></head>
<body>
  <h1>${escape(r.title)}</h1>
  ${r.subtitle ? `<div class="sub">${escape(r.subtitle)}</div>` : ''}
  <table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>
  ${summary}
  <div class="footer">Generado el ${r.generatedAt.toISOString()} · StorageOS</div>
</body></html>`;
  }
}

function escape(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatValue(v: string | number, type?: string): string {
  if (type === 'currency' && typeof v === 'number') {
    return v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
  }
  if (type === 'number' && typeof v === 'number') {
    return v.toLocaleString('es-ES');
  }
  return String(v);
}
