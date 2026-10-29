import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';

import { loadPuppeteer } from '../../common/puppeteer';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { renderContractHtml } from './contract-pdf-template';
import { composeContractTerms } from './contract-terms';
import { ContractsService } from './contracts.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';

// Puppeteer 25+ es ESM only. Usamos dynamic import() para que Jest (CJS)
// no rompa al cargar el modulo. El tipo `Browser` lo importamos
// estaticamente como type (no genera codigo en runtime).
type Browser = import('puppeteer').Browser;

/**
 * Genera el PDF del contrato con Puppeteer headless a partir del texto
 * firmado y la evidencia de la firma (`renderContractHtml`).
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

  /**
   * Al firmar se genera el PDF solo (con el texto firmado y la evidencia de la
   * firma), para que el inquilino lo tenga en su área de clientes. Best-effort:
   * un fallo de Puppeteer no afecta a la firma; se puede regenerar en la ficha.
   */
  @OnEvent(DOMAIN_EVENTS.contract_signed, { async: true, promisify: true })
  async onContractSigned(payload: DomainEventPayload): Promise<void> {
    // En los tests no hay Chromium (Puppeteer no carga bajo Jest).
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.generate({
        tenantId: payload.tenantId,
        userId: null,
        contractId: payload.entityId,
        meta: {},
      });
    } catch (err) {
      this.logger.warn(
        `[contract-pdf] no se pudo generar el PDF del contrato ${payload.entityId}: ${(err as Error).message}`,
      );
    }
  }

  async generate(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    meta: RequestMeta;
  }): Promise<{ pdfUrl: string }> {
    // Comprueba que el contrato existe en el tenant (y el alcance por local en el controller).
    await this.contracts.detail(args.tenantId, args.contractId);
    const input = await this.prisma.withTenant(async (tx) => {
      const [contract, tenant, signatures] = await Promise.all([
        tx.contract.findUniqueOrThrow({
          where: { id: args.contractId },
          select: {
            contractNumber: true,
            status: true,
            signedAt: true,
            signedTermsText: true,
            unit: { select: { unitType: { select: { propertyKind: true } } } },
          },
        }),
        tx.tenant.findUniqueOrThrow({
          where: { id: args.tenantId },
          select: { name: true, billingLegalName: true },
        }),
        tx.contractSignature.findMany({
          where: { contractId: args.contractId },
          orderBy: { signedAt: 'asc' },
        }),
      ]);
      const accepted = await tx.legalDocAcceptance.findMany({
        where: { contractId: args.contractId },
        orderBy: { acceptedAt: 'asc' },
        include: { version: { select: { title: true, version: true, contentHash: true } } },
      });
      // Firmado: el texto congelado. Si no lo hay (borrador, importado o firmado
      // antes de guardarse el texto), el que se compone con los datos actuales.
      const termsText =
        contract.signedTermsText ??
        (await composeContractTerms(tx, args.tenantId, args.contractId)).text;
      return {
        contractNumber: contract.contractNumber,
        housing: contract.unit.unitType.propertyKind === 'housing',
        status: contract.status,
        termsText,
        termsFrozen: !!contract.signedTermsText,
        signedAt: contract.signedAt,
        signatures,
        generalTerms: accepted.map((a) => ({
          title: a.version.title,
          version: a.version.version,
          contentHash: a.version.contentHash,
          acceptedAt: a.acceptedAt,
          channel: a.channel,
        })),
        tenantName: tenant.billingLegalName?.trim() || tenant.name,
        generatedAt: new Date(),
      };
    }, args.tenantId);
    const html = renderContractHtml(input);

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
      // Se guarda la forma "pública" (sin firmar) para poder re-firmarla más
      // tarde (`getSignedPdfUrl`/portal `getMyContractPdf`), pero nunca se
      // devuelve tal cual en la respuesta de este endpoint.
      const url = await this.files.getPresignedGetUrl('uploads', key, 300);
      return { pdfUrl: url };
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
    const puppeteer = await loadPuppeteer();
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
}
