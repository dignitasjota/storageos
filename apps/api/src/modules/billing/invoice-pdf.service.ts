import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { InvoicesService } from './invoices.service';

import type { Env } from '../../config/env.schema';

// Puppeteer ESM-only (ADR-023). Dynamic import + type-only.
type Browser = import('puppeteer').Browser;

@Injectable()
export class InvoicePdfService implements OnModuleDestroy {
  private readonly logger = new Logger(InvoicePdfService.name);
  private browserPromise: Promise<Browser> | null = null;
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly files: FilesService,
    config: ConfigService<Env, true>,
  ) {
    this.s3 = new S3Client({
      region: 'us-east-1',
      endpoint: `${config.get('MINIO_USE_SSL', { infer: true }) ? 'https' : 'http'}://${config.get('MINIO_ENDPOINT', { infer: true })}:${config.get('MINIO_PORT', { infer: true })}`,
      credentials: {
        accessKeyId: config.get('MINIO_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('MINIO_SECRET_KEY', { infer: true }),
      },
      forcePathStyle: true,
    });
    this.bucket = config.get('MINIO_BUCKET_INVOICES', { infer: true });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browserPromise) {
      try {
        const b = await this.browserPromise;
        await b.close();
      } catch {
        // ignore
      }
    }
  }

  async generate(tenantId: string, invoiceId: string): Promise<{ pdfUrl: string }> {
    const invoice = await this.invoices.detail(tenantId, invoiceId);
    if (invoice.status === 'draft') {
      throw new Error('No se puede generar PDF de un borrador');
    }
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true, slug: true, taxId: true, country: true, billingEmail: true },
        }),
      tenantId,
    );
    // En F2 puede no haber destinatario: customerId nullable desde
    // Fase 13A.3. Usamos un placeholder "Cliente sin identificar"
    // cuando no exista, manteniendo el PDF emitible.
    const customer = invoice.customerId
      ? await this.prisma.withTenant(
          (tx) =>
            tx.customer.findUniqueOrThrow({
              where: { id: invoice.customerId as string },
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
                documentType: true,
                documentNumber: true,
                email: true,
                address: true,
                city: true,
                postalCode: true,
                country: true,
              },
            }),
          tenantId,
        )
      : {
          firstName: null,
          lastName: null,
          companyName: 'Cliente sin identificar (F2)',
          customerType: 'business' as const,
          documentType: null,
          documentNumber: null,
          email: null,
          address: null,
          city: null,
          postalCode: null,
          country: 'ES',
        };

    const html = this.renderHtml({ invoice, tenant, customer });
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
        printBackground: true,
      });
      const key = `${tenantId}/invoices/${invoiceId}-${invoice.invoiceNumber.replace(/\//g, '_')}.pdf`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }),
      );
      const publicUrl = `${this.files.buildPublicUrl('invoices', key)}`;
      await this.invoices.attachPdf({ tenantId, invoiceId, pdfUrl: publicUrl });
      return { pdfUrl: publicUrl };
    } finally {
      await page.close();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) this.browserPromise = this.launchBrowser();
    try {
      const b = await this.browserPromise;
      if (b.connected) return b;
    } catch (err) {
      this.logger.warn(`Browser reset: ${(err as Error).message}`);
    }
    this.browserPromise = this.launchBrowser();
    return this.browserPromise;
  }

  private async launchBrowser(): Promise<Browser> {
    const { default: puppeteer } = await import('puppeteer');
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  private renderHtml(args: {
    invoice: Awaited<ReturnType<InvoicesService['detail']>>;
    tenant: {
      name: string;
      slug: string;
      taxId: string | null;
      country: string;
      billingEmail: string | null;
    };
    customer: {
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
    };
  }): string {
    const i = args.invoice;
    const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    const customerName =
      args.customer.customerType === 'business'
        ? (args.customer.companyName ?? 'Empresa')
        : [args.customer.firstName, args.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre';
    const itemsRows = i.items
      .map(
        (it) => `
        <tr>
          <td>${escapeHtml(it.description)}${
            it.periodStart && it.periodEnd
              ? `<div class="period">Periodo: ${it.periodStart} → ${it.periodEnd}</div>`
              : ''
          }</td>
          <td class="num">${it.quantity}</td>
          <td class="num">${eur(it.unitPrice)}</td>
          <td class="num">${it.taxRate}%</td>
          <td class="num">${eur(it.total)}</td>
        </tr>`,
      )
      .join('');

    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Factura ${i.invoiceNumber}</title>
<style>
  body { font-family: -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif; color: #111; font-size: 10.5pt; line-height: 1.4; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24pt; margin-bottom: 24pt; }
  h1 { font-size: 22pt; margin: 0 0 4pt; }
  .meta { color: #666; font-size: 9.5pt; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 16pt; margin-bottom: 18pt; }
  .party { border: 1px solid #e2e2e2; border-radius: 6pt; padding: 10pt 12pt; background: #fafafa; }
  .party strong { font-size: 11pt; }
  .party div.row { margin-top: 4pt; font-size: 9.5pt; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 8pt; }
  table.items th, table.items td { border-bottom: 1px solid #ddd; padding: 6pt 4pt; vertical-align: top; }
  table.items th { background: #f4f4f4; text-align: left; font-size: 9pt; text-transform: uppercase; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .period { color: #888; font-size: 8.5pt; }
  .totals { margin-top: 14pt; margin-left: auto; width: 260pt; }
  .totals .row { display: flex; justify-content: space-between; padding: 4pt 8pt; }
  .totals .row.grand { font-size: 13pt; font-weight: 600; border-top: 2px solid #111; margin-top: 4pt; }
  .verifactu { margin-top: 28pt; display: flex; gap: 18pt; align-items: flex-end; border-top: 1px solid #ddd; padding-top: 14pt; }
  .verifactu .qr img { width: 110pt; height: 110pt; }
  .verifactu .legal { font-size: 8.5pt; color: #666; max-width: 380pt; }
  .verifactu .hash { font-family: monospace; font-size: 7.5pt; color: #888; word-break: break-all; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Factura</h1>
    <div class="meta">N.º <strong>${i.invoiceNumber}</strong></div>
    <div class="meta">Fecha emisión: ${i.issueDate ?? '—'}</div>
    <div class="meta">Vencimiento: ${i.dueDate ?? '—'}</div>
  </div>
  <div style="text-align: right;">
    <strong>${escapeHtml(args.tenant.name)}</strong>
    ${args.tenant.taxId ? `<div class="meta">${args.tenant.taxId}</div>` : ''}
    ${args.tenant.billingEmail ? `<div class="meta">${args.tenant.billingEmail}</div>` : ''}
  </div>
</header>

<div class="parties">
  <div class="party">
    <strong>Emisor</strong>
    <div class="row">${escapeHtml(args.tenant.name)}</div>
    ${args.tenant.taxId ? `<div class="row">NIF/CIF: ${args.tenant.taxId}</div>` : ''}
    <div class="row">País: ${args.tenant.country}</div>
  </div>
  <div class="party">
    <strong>Cliente</strong>
    <div class="row">${escapeHtml(customerName)}</div>
    ${args.customer.documentNumber ? `<div class="row">${args.customer.documentType ?? 'Doc.'}: ${args.customer.documentNumber}</div>` : ''}
    ${args.customer.email ? `<div class="row">${args.customer.email}</div>` : ''}
    ${args.customer.address ? `<div class="row">${escapeHtml(args.customer.address)}, ${args.customer.postalCode ?? ''} ${escapeHtml(args.customer.city ?? '')} (${args.customer.country})</div>` : ''}
  </div>
</div>

<table class="items">
  <thead>
    <tr>
      <th>Concepto</th>
      <th class="num">Cantidad</th>
      <th class="num">P. unit.</th>
      <th class="num">IVA</th>
      <th class="num">Total</th>
    </tr>
  </thead>
  <tbody>${itemsRows}</tbody>
</table>

<div class="totals">
  <div class="row"><span>Base imponible</span><span class="num">${eur(i.subtotal)}</span></div>
  <div class="row"><span>IVA</span><span class="num">${eur(i.taxAmount)}</span></div>
  <div class="row grand"><span>Total</span><span class="num">${eur(i.total)}</span></div>
  ${i.amountPaid > 0 ? `<div class="row"><span>Pagado</span><span class="num">${eur(i.amountPaid)}</span></div>` : ''}
  ${i.amountPending > 0 && i.status !== 'paid' ? `<div class="row" style="color: #c00;"><span>Pendiente</span><span class="num">${eur(i.amountPending)}</span></div>` : ''}
</div>

<div class="verifactu">
  ${i.qrCodeUrl ? `<div class="qr"><img src="${i.qrCodeUrl}" alt="QR Verifactu" /></div>` : ''}
  <div class="legal">
    Factura verificable conforme al Reglamento que regula los sistemas
    informaticos de facturacion (RD 1007/2023, Verifactu).<br />
    <span class="hash">Huella: ${i.hash ?? '—'}</span>
    ${i.aeatCsv ? `<br /><span class="hash">CSV AEAT: ${i.aeatCsv}</span>` : ''}
  </div>
</div>

${i.notes ? `<div style="margin-top: 18pt; font-size: 9.5pt; color: #444;"><strong>Notas:</strong> ${escapeHtml(i.notes)}</div>` : ''}
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
