import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { renderContractClauses } from '@storageos/shared';

import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { ContractsService } from './contracts.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';

// Puppeteer 25+ es ESM only. Usamos dynamic import() para que Jest (CJS)
// no rompa al cargar el modulo. El tipo `Browser` lo importamos
// estaticamente como type (no genera codigo en runtime).
type Browser = import('puppeteer').Browser;

/**
 * Genera el PDF del contrato con Puppeteer headless. Plantilla HTML
 * inline (template literal) — para v1 no merece la pena Handlebars. En
 * Fase 4 (facturas con Verifactu) se introducira un sistema de
 * plantillas mas serio + queue con BullMQ.
 *
 * El PDF se sube a MinIO bucket `uploads` con key
 * `<tenantId>/contracts/<contractId>-<uuid>.pdf` y se persiste el
 * `signedPdfUrl` en `contracts`.
 *
 * Sincrono dentro del request (~1-3s por PDF). Aceptable para un user
 * que hace clic en "Generar PDF". Si el volumen sube, pasamos a queue.
 */
@Injectable()
export class ContractPdfService implements OnModuleDestroy {
  private readonly logger = new Logger(ContractPdfService.name);
  private browserPromise: Promise<Browser> | null = null;
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
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
    this.bucket = config.get('MINIO_BUCKET_UPLOADS', { infer: true });
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

  async generate(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    meta: RequestMeta;
  }): Promise<{ pdfUrl: string }> {
    const contract = await this.contracts.detail(args.tenantId, args.contractId);
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findUniqueOrThrow({
          where: { id: args.tenantId },
          select: {
            name: true,
            slug: true,
            country: true,
            taxId: true,
            contractClauses: true,
          },
        }),
      args.tenantId,
    );
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findUniqueOrThrow({
          where: { id: contract.customerId },
          select: {
            firstName: true,
            lastName: true,
            companyName: true,
            customerType: true,
            documentType: true,
            documentNumber: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            postalCode: true,
            country: true,
          },
        }),
      args.tenantId,
    );
    const html = this.renderHtml({ contract, tenant, customer });

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
        printBackground: true,
      });
      const key = this.files.buildContractPdfKey(args.tenantId, args.contractId);
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }),
      );
      const publicUrl = this.files.buildPublicUrl('uploads', key);
      await this.contracts.attachSignedPdf({
        tenantId: args.tenantId,
        userId: args.userId,
        contractId: args.contractId,
        pdfUrl: publicUrl,
        meta: args.meta,
      });
      return { pdfUrl: publicUrl };
    } finally {
      await page.close();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = this.launchBrowser();
    }
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
    contract: Awaited<ReturnType<ContractsService['detail']>>;
    tenant: {
      name: string;
      slug: string;
      country: string;
      taxId: string | null;
      contractClauses: string | null;
    };
    customer: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      customerType: 'individual' | 'business';
      documentType: string | null;
      documentNumber: string | null;
      email: string | null;
      phone: string | null;
      address: string | null;
      city: string | null;
      postalCode: string | null;
      country: string;
    };
  }): string {
    const c = args.contract;
    const cust = args.customer;
    const customerName =
      cust.customerType === 'business'
        ? (cust.companyName ?? 'Empresa')
        : [cust.firstName, cust.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
    const formatEur = (n: number) =>
      n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    const formatDate = (iso: string | null) =>
      iso
        ? new Date(iso).toLocaleDateString('es-ES', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })
        : '—';
    const esc = (s: string) =>
      s.replace(
        /[&<>"]/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!,
      );

    // Condiciones: si el tenant definió cláusulas propias, se renderizan con las
    // variables del contrato y sustituyen a las 5 cláusulas por defecto. El texto
    // legalmente firmado (prueba) es la firma electrónica + su hash; este PDF
    // refleja la plantilla vigente.
    const customClauses = args.tenant.contractClauses
      ? renderContractClauses(args.tenant.contractClauses, {
          contractNumber: c.contractNumber,
          customerName,
          unitCode: c.unitCode,
          facilityName: c.facilityName,
          priceMonthly: formatEur(c.priceMonthly),
          depositAmount: formatEur(c.depositAmount),
          startDate: formatDate(c.startDate),
          cancellationNoticeDays: String(c.cancellationNoticeDays),
          tenantName: args.tenant.name,
        })
      : null;
    const conditionsHtml = customClauses
      ? `<div style="white-space: pre-wrap;">${esc(customClauses)}</div>`
      : `<ol>
  <li>El presente contrato se renueva automáticamente cada periodo de facturación salvo notificación de baja con ${c.cancellationNoticeDays} días de antelación.</li>
  <li>El arrendatario es responsable del contenido depositado en el trastero. El arrendador no responde de objetos de valor.</li>
  <li>Está prohibido almacenar productos perecederos, inflamables o ilegales.</li>
  <li>El impago de dos cuotas consecutivas faculta al arrendador a desactivar el acceso al trastero.</li>
  <li>La devolución del trastero requiere retirar todos los enseres y dejarlo en las mismas condiciones de entrega.</li>
</ol>`;

    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Contrato ${c.contractNumber}</title>
<style>
  body { font-family: -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif; color: #111; font-size: 11pt; line-height: 1.45; }
  h1 { font-size: 22pt; margin: 0 0 4pt 0; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt 0; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
  .meta { color: #666; font-size: 10pt; margin-bottom: 18pt; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12pt; }
  .box { border: 1px solid #e2e2e2; border-radius: 6pt; padding: 10pt 12pt; background: #fafafa; }
  .box dt { font-size: 8.5pt; color: #666; text-transform: uppercase; letter-spacing: 0.5pt; margin-top: 6pt; }
  .box dd { margin: 2pt 0 0 0; font-weight: 500; }
  .total { font-size: 14pt; font-weight: 600; margin-top: 12pt; }
  .footer { margin-top: 36pt; font-size: 9pt; color: #888; }
  .signs { margin-top: 32pt; display: grid; grid-template-columns: 1fr 1fr; gap: 24pt; }
  .signs .line { border-top: 1px solid #444; padding-top: 6pt; font-size: 9pt; color: #666; }
</style>
</head>
<body>
<h1>Contrato de alquiler de trastero</h1>
<div class="meta">N.º ${c.contractNumber} · Emitido el ${formatDate(c.createdAt)}</div>

<div class="grid">
  <div class="box">
    <strong>Arrendador</strong>
    <dt>Empresa</dt><dd>${args.tenant.name}</dd>
    ${args.tenant.taxId ? `<dt>NIF/CIF</dt><dd>${args.tenant.taxId}</dd>` : ''}
    <dt>País</dt><dd>${args.tenant.country}</dd>
  </div>
  <div class="box">
    <strong>Arrendatario</strong>
    <dt>Nombre</dt><dd>${customerName}</dd>
    ${cust.documentType ? `<dt>${cust.documentType}</dt><dd>${cust.documentNumber ?? '—'}</dd>` : ''}
    ${cust.email ? `<dt>Email</dt><dd>${cust.email}</dd>` : ''}
    ${cust.phone ? `<dt>Teléfono</dt><dd>${cust.phone}</dd>` : ''}
    ${cust.address ? `<dt>Dirección</dt><dd>${cust.address}, ${cust.postalCode ?? ''} ${cust.city ?? ''} (${cust.country})</dd>` : ''}
  </div>
</div>

<h2>Objeto del contrato</h2>
<div class="box">
  <dt>Local</dt><dd>${c.facilityName}</dd>
  <dt>Trastero</dt><dd>${c.unitCode}</dd>
  <dt>Inicio</dt><dd>${formatDate(c.startDate)}</dd>
  <dt>Finalización</dt><dd>${c.endDate ? formatDate(c.endDate) : 'Sin fecha de finalización (renovación automática)'}</dd>
</div>

<h2>Económico</h2>
<div class="box">
  <dt>Cuota mensual base</dt><dd>${formatEur(c.priceMonthly)}</dd>
  ${c.discountAmount > 0 ? `<dt>Descuento</dt><dd>− ${formatEur(c.discountAmount)} ${c.discountReason ? `(${c.discountReason})` : ''}</dd>` : ''}
  <dt>Fianza</dt><dd>${formatEur(c.depositAmount)}</dd>
  <div class="total">Cuota efectiva mensual: ${formatEur(c.effectivePrice)}</div>
</div>

<h2>Condiciones</h2>
${conditionsHtml}

<div class="signs">
  <div class="line">Arrendador (${args.tenant.name})</div>
  <div class="line">Arrendatario (${customerName})</div>
</div>

<div class="footer">Documento generado automáticamente por StorageOS — ${args.tenant.slug}</div>
</body>
</html>`;
  }
}
