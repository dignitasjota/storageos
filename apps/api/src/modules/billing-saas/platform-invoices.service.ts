import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { FilesService } from '../files/files.service';

import type { Env } from '../../config/env.schema';
import type {
  PlatformBillingSettingsDto,
  PlatformInvoiceDto,
  UpdatePlatformBillingSettingsInput,
} from '@storageos/shared';

// Puppeteer ESM-only (ADR-023): dynamic import + type-only.
type Browser = import('puppeteer').Browser;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const eur = (n: number): string =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Facturación del SaaS: StorageOS emite facturas de suscripción a sus tenants.
 * Distinto de las facturas del tenant a sus inquilinos (Fase 4 / Veri*Factu).
 * v1: factura conforme (numeración por serie/año + IVA + PDF), SIN Veri*Factu.
 */
@Injectable()
export class PlatformInvoicesService {
  private readonly logger = new Logger(PlatformInvoicesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly email: EmailService,
    config: ConfigService<Env, true>,
  ) {
    this.s3 = new S3Client({
      endpoint: config.get('MINIO_ENDPOINT', { infer: true }),
      region: 'us-east-1',
      credentials: {
        accessKeyId: config.get('MINIO_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('MINIO_SECRET_KEY', { infer: true }),
      },
      forcePathStyle: true,
    });
    this.bucket = config.get('MINIO_BUCKET_INVOICES', { infer: true });
  }

  // ---- config del emisor ----

  async getSettings(): Promise<PlatformBillingSettingsDto> {
    let row = await this.admin.platformBillingSettings.findFirst();
    row ??= await this.admin.platformBillingSettings.create({ data: {} });
    return this.settingsToDto(row);
  }

  async updateSettings(
    input: UpdatePlatformBillingSettingsInput,
  ): Promise<PlatformBillingSettingsDto> {
    const existing = await this.admin.platformBillingSettings.findFirst();
    const data = {
      ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
      ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
      ...(input.address !== undefined ? { address: input.address || null } : {}),
      ...(input.city !== undefined ? { city: input.city || null } : {}),
      ...(input.postalCode !== undefined ? { postalCode: input.postalCode || null } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.email !== undefined ? { email: input.email || null } : {}),
      ...(input.taxRate !== undefined ? { taxRate: input.taxRate } : {}),
      ...(input.seriesPrefix !== undefined ? { seriesPrefix: input.seriesPrefix } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    const row = existing
      ? await this.admin.platformBillingSettings.update({ where: { id: existing.id }, data })
      : await this.admin.platformBillingSettings.create({ data });
    return this.settingsToDto(row);
  }

  // ---- facturas ----

  async listForTenant(tenantId: string): Promise<PlatformInvoiceDto[]> {
    const rows = await this.admin.platformInvoice.findMany({
      where: { tenantId },
      orderBy: { issuedAt: 'desc' },
    });
    return rows.map((r) => this.invoiceToDto(r));
  }

  /** Todas las facturas SaaS (cross-tenant) por fecha de emisión, para el export contable. */
  async listAll(from?: string, to?: string): Promise<PlatformInvoiceDto[]> {
    const issuedAt: { gte?: Date; lte?: Date } = {};
    if (from) issuedAt.gte = new Date(`${from}T00:00:00.000Z`);
    if (to) issuedAt.lte = new Date(`${to}T23:59:59.999Z`);
    const rows = await this.admin.platformInvoice.findMany({
      where: Object.keys(issuedAt).length ? { issuedAt } : {},
      orderBy: { issuedAt: 'asc' },
    });
    return rows.map((r) => this.invoiceToDto(r));
  }

  /** Emite la factura de un pago (idempotente por `payment_id`). */
  async issueForPayment(paymentId: string): Promise<PlatformInvoiceDto> {
    const existing = await this.admin.platformInvoice.findUnique({ where: { paymentId } });
    if (existing) return this.invoiceToDto(existing);

    const payment = await this.admin.tenantSubscriptionPayment.findUnique({
      where: { id: paymentId },
      include: { tenant: true },
    });
    if (!payment) {
      throw new NotFoundException({ code: 'payment_not_found', message: 'Pago no encontrado' });
    }
    if (payment.status !== 'paid') {
      throw new BadRequestException({
        code: 'payment_not_paid',
        message: 'Solo se factura un pago cobrado',
      });
    }
    const settings = await this.getSettings();
    if (!settings.enabled) {
      throw new BadRequestException({
        code: 'platform_billing_disabled',
        message: 'Activa la facturación del SaaS y completa los datos del emisor',
      });
    }

    const total = Number(payment.amount);
    const taxRate = settings.taxRate;
    const base = round2(total / (1 + taxRate / 100));
    const taxAmount = round2(total - base);
    // La serie va por el AÑO DE EMISIÓN de la factura (ahora), no por la fecha
    // del pago: un pago manual con `paidAt` retroactivo no debe numerarse en la
    // serie de un año anterior (rompería la secuencia y la coherencia fiscal).
    const series = String(new Date().getUTCFullYear());
    const tenant = payment.tenant;

    // Numeración secuencial atómica por serie (año) + creación de la factura.
    const created = await this.admin.$transaction(async (tx) => {
      const last = await tx.platformInvoice.findFirst({
        where: { series },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const number = (last?.number ?? 0) + 1;
      const fullNumber = `${settings.seriesPrefix}-${series}-${String(number).padStart(4, '0')}`;
      return tx.platformInvoice.create({
        data: {
          series,
          number,
          fullNumber,
          tenantId: tenant.id,
          tenantName: tenant.name,
          tenantTaxId: tenant.taxId,
          tenantEmail: tenant.billingEmail,
          tenantAddress: null,
          planSlug: payment.planSlug,
          planName: payment.planName,
          periodStart: payment.periodStart,
          periodEnd: payment.periodEnd,
          baseAmount: base,
          taxRate,
          taxAmount,
          total,
          currency: payment.currency,
          paymentId: payment.id,
        },
      });
    });

    // PDF (best-effort: si falla, la factura queda emitida sin PDF y se puede regenerar).
    try {
      const key = await this.renderPdf(created.id, settings, created);
      await this.admin.platformInvoice.update({ where: { id: created.id }, data: { pdfUrl: key } });
      created.pdfUrl = key;
    } catch (err) {
      this.logger.warn(`PDF factura ${created.fullNumber} falló: ${(err as Error).message}`);
    }

    // Email best-effort al tenant.
    await this.sendEmail(created, settings).catch((err) =>
      this.logger.warn(`Email factura ${created.fullNumber} falló: ${(err as Error).message}`),
    );

    return this.invoiceToDto(created);
  }

  /** Para el hook automático: no lanza (best-effort). */
  async issueForPaymentBestEffort(paymentId: string): Promise<void> {
    try {
      const settings = await this.admin.platformBillingSettings.findFirst();
      if (!settings?.enabled) return; // facturación desactivada
      await this.issueForPayment(paymentId);
    } catch (err) {
      this.logger.warn(`Auto-factura del pago ${paymentId} falló: ${(err as Error).message}`);
    }
  }

  /** URL firmada (GET) del PDF; el bucket de facturas es privado. */
  async getPdfUrl(id: string): Promise<{ url: string }> {
    const inv = await this.admin.platformInvoice.findUnique({ where: { id } });
    if (!inv?.pdfUrl) {
      throw new NotFoundException({ code: 'pdf_not_available', message: 'Sin PDF' });
    }
    return { url: await this.files.getPresignedGetUrl('invoices', inv.pdfUrl, 300) };
  }

  async resend(id: string): Promise<void> {
    const inv = await this.admin.platformInvoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException({ code: 'invoice_not_found', message: 'No encontrada' });
    const settings = await this.getSettings();
    await this.sendEmail(inv, settings);
  }

  // ---- helpers ----

  private async sendEmail(
    inv: { fullNumber: string; tenantEmail: string | null; total: unknown; currency: string },
    settings: PlatformBillingSettingsDto,
  ): Promise<void> {
    if (!inv.tenantEmail) return;
    const html = `<p>Adjuntamos tu factura <strong>${esc(inv.fullNumber)}</strong> por ${eur(
      Number(inv.total),
    )}.</p><p>Puedes descargarla desde tu panel. Gracias por confiar en ${esc(
      settings.legalName || 'StorageOS',
    )}.</p>`;
    await this.email.sendRendered({
      to: inv.tenantEmail,
      subject: `Factura ${inv.fullNumber}`,
      html,
      text: `Factura ${inv.fullNumber} por ${eur(Number(inv.total))}.`,
    });
  }

  private async renderPdf(
    id: string,
    settings: PlatformBillingSettingsDto,
    inv: {
      fullNumber: string;
      issuedAt: Date;
      tenantName: string;
      tenantTaxId: string | null;
      planName: string | null;
      periodStart: Date | null;
      periodEnd: Date | null;
      baseAmount: unknown;
      taxRate: unknown;
      taxAmount: unknown;
      total: unknown;
    },
  ): Promise<string> {
    const html = this.renderHtml(settings, inv);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
        printBackground: true,
      });
      const key = `platform/${id}-${inv.fullNumber.replace(/\//g, '_')}.pdf`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: pdf,
          ContentType: 'application/pdf',
        }),
      );
      return key;
    } finally {
      await page.close();
    }
  }

  private renderHtml(
    s: PlatformBillingSettingsDto,
    inv: {
      fullNumber: string;
      issuedAt: Date;
      tenantName: string;
      tenantTaxId: string | null;
      planName: string | null;
      periodStart: Date | null;
      periodEnd: Date | null;
      baseAmount: unknown;
      taxRate: unknown;
      taxAmount: unknown;
      total: unknown;
    },
  ): string {
    const period =
      inv.periodStart && inv.periodEnd
        ? `${inv.periodStart.toLocaleDateString('es-ES')} – ${inv.periodEnd.toLocaleDateString('es-ES')}`
        : '';
    const issuer = [
      s.legalName,
      s.taxId ? `NIF: ${s.taxId}` : '',
      s.address,
      [s.postalCode, s.city].filter(Boolean).join(' '),
      s.country,
    ]
      .filter(Boolean)
      .map((l) => esc(String(l)))
      .join('<br>');
    const client = [inv.tenantName, inv.tenantTaxId ? `NIF: ${inv.tenantTaxId}` : '']
      .filter(Boolean)
      .map((l) => esc(String(l)))
      .join('<br>');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
      body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12px}
      h1{font-size:20px;margin:0 0 4px}
      .row{display:flex;justify-content:space-between;margin-top:24px}
      .box{width:48%}
      table{width:100%;border-collapse:collapse;margin-top:28px}
      th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}
      td.n,th.n{text-align:right}
      .totals{margin-top:16px;margin-left:auto;width:40%}
      .totals div{display:flex;justify-content:space-between;padding:4px 0}
      .totals .grand{font-weight:bold;font-size:14px;border-top:2px solid #111;margin-top:4px;padding-top:8px}
      .muted{color:#666}
    </style></head><body>
      <h1>Factura ${esc(inv.fullNumber)}</h1>
      <div class="muted">Fecha: ${inv.issuedAt.toLocaleDateString('es-ES')}</div>
      <div class="row">
        <div class="box"><strong>Emisor</strong><br>${issuer || '—'}</div>
        <div class="box"><strong>Cliente</strong><br>${client || '—'}</div>
      </div>
      <table><thead><tr><th>Concepto</th><th class="n">Base</th></tr></thead>
      <tbody><tr><td>Suscripción ${esc(inv.planName ?? 'StorageOS')}${
        period ? ` · ${esc(period)}` : ''
      }</td><td class="n">${eur(Number(inv.baseAmount))}</td></tr></tbody></table>
      <div class="totals">
        <div><span>Base imponible</span><span>${eur(Number(inv.baseAmount))}</span></div>
        <div><span>IVA (${Number(inv.taxRate)}%)</span><span>${eur(Number(inv.taxAmount))}</span></div>
        <div class="grand"><span>Total</span><span>${eur(Number(inv.total))}</span></div>
      </div>
    </body></html>`;
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
    return puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }

  private settingsToDto(r: {
    legalName: string;
    taxId: string;
    address: string | null;
    city: string | null;
    postalCode: string | null;
    country: string;
    email: string | null;
    taxRate: unknown;
    seriesPrefix: string;
    enabled: boolean;
  }): PlatformBillingSettingsDto {
    return {
      legalName: r.legalName,
      taxId: r.taxId,
      address: r.address,
      city: r.city,
      postalCode: r.postalCode,
      country: r.country,
      email: r.email,
      taxRate: Number(r.taxRate),
      seriesPrefix: r.seriesPrefix,
      enabled: r.enabled,
    };
  }

  private invoiceToDto(r: {
    id: string;
    fullNumber: string;
    tenantId: string;
    tenantName: string;
    tenantTaxId: string | null;
    planName: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    baseAmount: unknown;
    taxRate: unknown;
    taxAmount: unknown;
    total: unknown;
    currency: string;
    status: string;
    issuedAt: Date;
    pdfUrl: string | null;
    paymentId: string | null;
  }): PlatformInvoiceDto {
    return {
      id: r.id,
      fullNumber: r.fullNumber,
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      tenantTaxId: r.tenantTaxId,
      planName: r.planName,
      periodStart: r.periodStart?.toISOString() ?? null,
      periodEnd: r.periodEnd?.toISOString() ?? null,
      baseAmount: Number(r.baseAmount),
      taxRate: Number(r.taxRate),
      taxAmount: Number(r.taxAmount),
      total: Number(r.total),
      currency: r.currency,
      status: r.status,
      issuedAt: r.issuedAt.toISOString(),
      hasPdf: Boolean(r.pdfUrl),
      paymentId: r.paymentId,
    };
  }
}
