import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { loadPuppeteer } from '../../common/puppeteer';
import { HoldedSyncService } from '../accounting/holded-sync.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { renderInvoiceHtml } from './invoice-pdf-template';
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
    private readonly holded: HoldedSyncService,
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

  /** El PDF guardado o, si aún no lo tiene, lo genera ahora. */
  async ensure(tenantId: string, invoiceId: string): Promise<void> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({ where: { id: invoiceId }, select: { pdfUrl: true, status: true } }),
      tenantId,
    );
    if (!row || row.pdfUrl || row.status === 'draft') return;
    await this.generate(tenantId, invoiceId);
  }

  async generate(tenantId: string, invoiceId: string): Promise<{ pdfUrl: string }> {
    const invoice = await this.invoices.detail(tenantId, invoiceId);
    if (invoice.status === 'draft') {
      throw new Error('No se puede generar PDF de un borrador');
    }
    if (invoice.issuedBy === 'holded') {
      // Emitida en Holded: su PDF es el legal (número y QR de Veri*Factu de Holded).
      return this.store(
        tenantId,
        invoiceId,
        invoice.invoiceNumber,
        await this.holded.downloadIssuedPdf(tenantId, invoiceId),
      );
    }
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            slug: true,
            taxId: true,
            country: true,
            billingEmail: true,
            billingLegalName: true,
            billingAddress: true,
            billingPostalCode: true,
            billingCity: true,
          },
        }),
      tenantId,
    );
    // Plan Administrador: emite el propietario (sus datos) por cuenta del tenant.
    const owner = invoice.ownerId
      ? await this.prisma.withTenant(
          (tx) =>
            tx.owner.findUnique({
              where: { id: invoice.ownerId ?? '' },
              select: {
                legalName: true,
                taxId: true,
                email: true,
                address: true,
                postalCode: true,
                city: true,
              },
            }),
          tenantId,
        )
      : null;
    const issuer = owner
      ? {
          name: owner.legalName,
          taxId: owner.taxId,
          country: tenant.country,
          billingEmail: owner.email,
          address: [owner.address, [owner.postalCode, owner.city].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', '),
          managedBy: tenant.name,
        }
      : {
          // Nombre comercial arriba; en «Emisor», la razón social y el domicilio
          // fiscal (obligatorios en la factura, RD 1619/2012 art. 6).
          name: tenant.name,
          legalName: tenant.billingLegalName,
          taxId: tenant.taxId,
          country: tenant.country,
          billingEmail: tenant.billingEmail,
          address: [
            tenant.billingAddress,
            [tenant.billingPostalCode, tenant.billingCity].filter(Boolean).join(' '),
          ]
            .filter(Boolean)
            .join(', '),
        };
    // En una simplificada puede no haber destinatario (cliente no identificado).
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
      : null;

    const html = renderInvoiceHtml({ invoice, issuer, customer });
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
        printBackground: true,
      });
      return await this.store(tenantId, invoiceId, invoice.invoiceNumber, pdfBuffer);
    } finally {
      await page.close();
    }
  }

  private async store(
    tenantId: string,
    invoiceId: string,
    invoiceNumber: string,
    pdfBuffer: Uint8Array,
  ): Promise<{ pdfUrl: string }> {
    const key = `${tenantId}/invoices/${invoiceId}-${invoiceNumber.replace(/[/\\]/g, '_')}.pdf`;
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
    // Se guarda la forma "pública" (sin firmar) para poder re-firmarla más
    // tarde vía `presignFromPublicUrl` (y para el link que se manda en el
    // email de recordatorio de impago, que necesita seguir siendo válido
    // días después) — pero NUNCA se devuelve tal cual en la respuesta.
    const url = await this.files.getPresignedGetUrl('invoices', key, 300);
    return { pdfUrl: url };
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
    const puppeteer = await loadPuppeteer();
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
}
