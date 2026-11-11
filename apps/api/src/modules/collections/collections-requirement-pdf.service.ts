import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOSED_CASE_STATUSES, MIN_NOTICE_DAYS } from '@storageos/shared';

import { formatDateLong, todayInTimezone } from '../../common/format';
import { toCents } from '../../common/money';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { loadPuppeteer } from '../../common/puppeteer';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { renderRequirementHtml, type RequirementData } from './requirement-template';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';
import type { DelinquencyRequirementPdfDto } from '@storageos/shared';

// Puppeteer 25+ es ESM only → dynamic import() para no romper Jest (CJS).
type Browser = import('puppeteer').Browser;

/**
 * Genera el PDF del **requerimiento fehaciente de pago** de un expediente de
 * impago: la carta que el operador imprime y envía por burofax (o entrega en
 * mano con acuse). NO es el acuse del burofax (eso lo sube el operador después,
 * `kind: burofax_receipt`); es el documento A ENVIAR.
 *
 * Marco legal ES: no hay lien law, así que el requerimiento NO ejecuta nada —
 * intima al pago en el plazo del tenant (`collectionsNoticeDays`) y advierte de
 * las consecuencias contractuales (retención de acceso / disposición del
 * contenido según la cláusula del contrato, `collectionsClauseRef`). La validez
 * depende del contrato + asesoría del operador; el texto es una plantilla.
 *
 * El PDF se guarda en MinIO privado (`uploads`) y se registra como evidencia del
 * expediente (`delinquency_case_file`, `kind: requirement`) → aparece en el
 * detalle con URL firmada. Síncrono dentro del request (~1-3 s).
 */
@Injectable()
export class CollectionsRequirementPdfService implements OnModuleDestroy {
  private readonly logger = new Logger(CollectionsRequirementPdfService.name);
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

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
    caseId: string;
    facilityScope: string[] | null;
  }): Promise<DelinquencyRequirementPdfDto> {
    const data = await this.loadData(args.tenantId, args.caseId, args.facilityScope);
    const html = renderRequirementHtml(data);

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdfBuffer = Buffer.from(
        await page.pdf({
          format: 'A4',
          margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
          printBackground: true,
        }),
      );
      const objectKey = `${args.tenantId}/collections/${args.caseId}/requirement/${randomUUID()}.pdf`;
      await this.files.putObject({
        bucket: 'uploads',
        key: objectKey,
        body: pdfBuffer,
        contentType: 'application/pdf',
      });
      // Registra el PDF como evidencia del expediente + deja rastro en el timeline.
      await this.prisma.withTenant(async (tx) => {
        await tx.delinquencyCaseFile.create({
          data: {
            tenantId: args.tenantId,
            caseId: args.caseId,
            kind: 'requirement',
            objectKey,
            contentType: 'application/pdf',
            createdByUserId: args.userId,
          },
        });
        await tx.delinquencyCaseEvent.create({
          data: {
            tenantId: args.tenantId,
            caseId: args.caseId,
            eventType: 'note',
            payload: { requirementPdf: true, debtCents: data.debtCents } as Prisma.InputJsonValue,
            createdByUserId: args.userId,
          },
        });
      }, args.tenantId);
      const url = await this.files.getPresignedGetUrl('uploads', objectKey);
      return { url };
    } finally {
      await page.close();
    }
  }

  private async loadData(
    tenantId: string,
    caseId: string,
    facilityScope: string[] | null,
  ): Promise<RequirementData> {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.delinquencyCase.findFirst({
        where: { id: caseId, tenantId },
        select: {
          id: true,
          contractId: true,
          facilityId: true,
          status: true,
          noticeDays: true,
          customer: {
            select: {
              customerType: true,
              firstName: true,
              lastName: true,
              companyName: true,
              documentType: true,
              documentNumber: true,
              address: true,
              city: true,
              postalCode: true,
            },
          },
          unit: { select: { code: true } },
          contract: {
            select: {
              contractNumber: true,
              owner: {
                select: {
                  legalName: true,
                  taxId: true,
                  address: true,
                  city: true,
                  postalCode: true,
                },
              },
              unit: {
                select: {
                  facility: {
                    select: {
                      name: true,
                      address: true,
                      city: true,
                      postalCode: true,
                      contactPhone: true,
                      contactEmail: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'case_not_found',
          message: 'Expediente no encontrado',
        });
      }
      if (facilityScope && row.facilityId && !facilityScope.includes(row.facilityId)) {
        throw new NotFoundException({
          code: 'case_not_found',
          message: 'Expediente no encontrado',
        });
      }
      if (CLOSED_CASE_STATUSES.includes(row.status)) {
        throw new BadRequestException({
          code: 'case_closed',
          message: 'El expediente está cerrado: ya no se envía un requerimiento',
        });
      }
      // Sin dirección postal no hay a dónde mandar el burofax.
      if (!row.customer?.address || !row.customer.city) {
        throw new BadRequestException({
          code: 'customer_address_required',
          message:
            'Falta la dirección postal del inquilino: añádela en su ficha para poder enviarle el requerimiento.',
        });
      }

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          name: true,
          slug: true,
          taxId: true,
          billingLegalName: true,
          billingAddress: true,
          billingCity: true,
          billingPostalCode: true,
          timezone: true,
          transferIban: true,
          customDomain: true,
          customDomainVerifiedAt: true,
          collectionsNoticeDays: true,
          collectionsClauseRef: true,
        },
      });
      const tz = tenant.timezone ?? 'Europe/Madrid';
      const today = todayInTimezone(tz);
      // Solo lo vencido (desde el día siguiente al vencimiento).
      const invoices = await tx.invoice.findMany({
        where: {
          tenantId,
          contractId: row.contractId,
          kind: 'invoice',
          deletedAt: null,
          OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: today } }],
        },
        select: {
          invoiceNumber: true,
          issueDate: true,
          dueDate: true,
          total: true,
          amountPaid: true,
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      });

      const lines = invoices
        .map((inv) => ({
          number: inv.invoiceNumber ?? '—',
          issueDate: inv.issueDate ? inv.issueDate.toISOString().slice(0, 10) : '—',
          dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : '—',
          totalCents: toCents(inv.total),
          pendingCents: Math.max(0, toCents(inv.total) - toCents(inv.amountPaid)),
        }))
        .filter((l) => l.pendingCents > 0);
      const debtCents = lines.reduce((s, l) => s + l.pendingCents, 0);
      const owner = row.contract?.owner ?? null;
      const ownerAddress = owner
        ? [owner.address, [owner.postalCode, owner.city].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(', ')
        : null;
      const tenantAddress = [
        tenant.billingAddress,
        [tenant.billingPostalCode, tenant.billingCity].filter(Boolean).join(' '),
      ]
        .filter(Boolean)
        .join(', ');

      return {
        // El arrendador del contrato: el propietario del local, si lo hay; si
        // no, la empresa con su razón social.
        issuer: owner
          ? {
              name: owner.legalName,
              taxId: owner.taxId,
              address: ownerAddress || null,
              managedBy: tenant.name,
            }
          : {
              name: tenant.billingLegalName || tenant.name,
              taxId: tenant.taxId,
              address: tenantAddress || null,
              managedBy: null,
            },
        noticeDays: Math.max(
          MIN_NOTICE_DAYS,
          row.noticeDays ?? tenant.collectionsNoticeDays ?? MIN_NOTICE_DAYS,
        ),
        clauseRef: tenant.collectionsClauseRef,
        customer: row.customer,
        unitCode: row.unit?.code ?? null,
        contractNumber: row.contract?.contractNumber ?? null,
        facility: row.contract?.unit?.facility ?? null,
        lines,
        debtCents,
        payment: {
          iban: tenant.transferIban,
          portalUrl: tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant),
        },
        today: formatDateLong(new Date(), tz),
      };
    }, tenantId);
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
