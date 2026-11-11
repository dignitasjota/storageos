import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  CASE_CHARGE_LABELS,
  CASE_FILE_KIND_LABELS,
  CASE_STATUS_LABELS,
  CUSTODY_WEEKS_BEFORE_ABANDONMENT,
  type CaseFileKind,
  type CustodyActInput,
} from '@storageos/shared';

import { formatDateLong, todayInTimezone } from '../../common/format';
import { toCents } from '../../common/money';
import { loadPuppeteer } from '../../common/puppeteer';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import {
  renderCustodyActHtml,
  renderDossierHtml,
  renderMonitorioHtml,
  type CaseDocData,
} from './collections-documents-template';

import type { Prisma } from '@storageos/database';

// Puppeteer 25+ es ESM only → dynamic import() para no romper Jest (CJS).
type Browser = import('puppeteer').Browser;

const DAY = 86_400_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Fotos que caben en el dossier (y tamaño máximo de cada una). */
const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

const EVENT_LABELS: Record<string, string> = {
  opened: 'Expediente abierto',
  overlock_placed: 'Candado puesto',
  overlock_removed: 'Candado quitado',
  notice_sent: 'Requerimiento enviado',
  notice_received: 'Requerimiento recibido',
  deadline_expired: 'Plazo vencido sin pagar',
  contract_resolved: 'Contrato resuelto',
  goods_moved: 'Bienes trasladados a custodia',
  payment_received: 'Pago recibido',
  inventory_done: 'Inventario hecho',
  disposal_started: 'Disposición iniciada',
  disposal_done: 'Disposición completada',
  settlement_done: 'Liquidación',
  closed: 'Expediente cerrado',
  note: 'Nota',
  paused: 'En pausa por un plan de pagos',
  resumed: 'Sigue el expediente',
  charge_added: 'Gastos facturados',
  surplus_returned: 'Sobrante devuelto',
  pickup_requested: 'Cita pedida para retirar los bienes',
  pickup_approved: 'Cita concedida',
  pickup_rejected: 'Cita rechazada',
  pickup_done: 'Bienes retirados',
  document_generated: 'Documento generado',
};

const COMM_STATUS: Record<string, string> = {
  pending: 'Pendiente',
  processing: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  failed: 'Falló',
  bounced: 'Rebotado',
  skipped: 'No enviado',
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  sepa_debit: 'Domiciliación',
  bank_transfer: 'Transferencia',
  bizum: 'Bizum',
  other: 'Otro',
};

/** `2026-11-11` (día, sin zona) → «11 de noviembre de 2026». */
const dayLong = (d: Date) =>
  formatDateLong(new Date(`${d.toISOString().slice(0, 10)}T12:00:00Z`), 'UTC');

/**
 * Documentos de un expediente de impago en PDF: el acta del traslado y la
 * custodia, el dossier con todo lo que acredita el impago y el borrador de la
 * petición de juicio monitorio. Cada uno queda como evidencia del expediente.
 */
@Injectable()
export class CollectionsDocumentsService implements OnModuleDestroy {
  private readonly logger = new Logger(CollectionsDocumentsService.name);
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
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

  async custodyAct(args: {
    tenantId: string;
    userId: string;
    caseId: string;
    input: CustodyActInput;
    facilityScope: string[] | null;
  }): Promise<{ url: string }> {
    const { data, row } = await this.load(args.tenantId, args.caseId, args.facilityScope);
    if (!row.contractResolvedAt) {
      throw new BadRequestException({
        code: 'contract_not_resolved',
        message: 'El acta del traslado es para después de resolver el contrato',
      });
    }
    const html = renderCustodyActHtml({
      ...data,
      items: args.input.items
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 300),
      witnesses: args.input.witnesses?.trim() || null,
      custodyLocation: row.custodyLocation,
      movedAt: row.goodsMovedAt ? dayLong(row.goodsMovedAt) : null,
      contractResolvedAt: row.contractResolvedAt ? dayLong(row.contractResolvedAt) : null,
      abandonmentFrom: row.goodsMovedAt
        ? dayLong(new Date(row.goodsMovedAt.getTime() + CUSTODY_WEEKS_BEFORE_ABANDONMENT * 7 * DAY))
        : null,
    });
    return this.store(args, 'custody_act', html);
  }

  async dossier(args: {
    tenantId: string;
    userId: string;
    caseId: string;
    facilityScope: string[] | null;
  }): Promise<{ url: string }> {
    const { data, row } = await this.load(args.tenantId, args.caseId, args.facilityScope);
    const extra = await this.prisma.withTenant(async (tx) => {
      const firstDue = data.invoices[0]?.dueDate ?? row.openedAt.toISOString().slice(0, 10);
      const since = new Date(new Date(`${firstDue}T00:00:00Z`).getTime() - 7 * DAY);
      const [events, comms, payments, files] = await Promise.all([
        tx.delinquencyCaseEvent.findMany({
          where: { caseId: row.id },
          include: { createdBy: { select: { fullName: true } } },
          orderBy: { occurredAt: 'asc' },
        }),
        tx.communication.findMany({
          where: { customerId: row.customerId, createdAt: { gte: since } },
          select: { createdAt: true, sentAt: true, channel: true, subject: true, status: true },
          orderBy: { createdAt: 'asc' },
          take: 100,
        }),
        tx.payment.findMany({
          where: { invoice: { contractId: row.contractId } },
          select: {
            paidAt: true,
            createdAt: true,
            amount: true,
            methodType: true,
            status: true,
            returnedAt: true,
            invoice: { select: { invoiceNumber: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        }),
        tx.delinquencyCaseFile.findMany({
          where: { caseId: row.id },
          orderBy: { createdAt: 'asc' },
        }),
      ]);
      return { events, comms, payments, files };
    }, args.tenantId);

    let photos = 0;
    const files = [];
    for (const f of extra.files) {
      let imageDataUri: string | null = null;
      if (f.contentType && IMAGE_TYPES.has(f.contentType) && photos < MAX_PHOTOS) {
        try {
          const bytes = await this.files.getObject({ bucket: 'uploads', key: f.objectKey });
          if (bytes.length <= MAX_PHOTO_BYTES) {
            imageDataUri = `data:${f.contentType};base64,${bytes.toString('base64')}`;
            photos++;
          }
        } catch (err) {
          this.logger.warn(`dossier photo ${f.id}: ${(err as Error).message}`);
        }
      }
      files.push({
        label: CASE_FILE_KIND_LABELS[f.kind as CaseFileKind] ?? f.kind,
        date: dayLong(f.createdAt),
        imageDataUri,
      });
    }

    const html = renderDossierHtml({
      ...data,
      statusLabel: CASE_STATUS_LABELS[row.status],
      openedAt: dayLong(row.openedAt),
      timeline: extra.events.map((e) => ({
        date: dayLong(e.occurredAt),
        label: EVENT_LABELS[e.eventType] ?? e.eventType,
        by: e.createdBy?.fullName ?? null,
        detail: eventDetail(e.eventType, (e.payload ?? {}) as Record<string, unknown>),
      })),
      communications: extra.comms.map((c) => ({
        date: dayLong(c.sentAt ?? c.createdAt),
        channel:
          c.channel === 'whatsapp' ? 'WhatsApp' : c.channel === 'email' ? 'Correo' : c.channel,
        subject: c.subject ?? '—',
        status: COMM_STATUS[c.status] ?? c.status,
      })),
      payments: extra.payments.map((p) => ({
        date: dayLong(p.paidAt ?? p.createdAt),
        invoiceNumber: p.invoice?.invoiceNumber ?? '—',
        amount: Number(p.amount),
        method: METHOD_LABELS[p.methodType] ?? p.methodType,
        status: p.returnedAt ? 'Devuelto' : p.status === 'succeeded' ? 'Cobrado' : p.status,
      })),
      files,
    });
    return this.store(args, 'dossier', html);
  }

  async monitorio(args: {
    tenantId: string;
    userId: string;
    caseId: string;
    facilityScope: string[] | null;
  }): Promise<{ url: string }> {
    const { data } = await this.load(args.tenantId, args.caseId, args.facilityScope);
    if (data.debtCents <= 0) {
      throw new BadRequestException({
        code: 'no_debt',
        message: 'No hay deuda vencida que reclamar',
      });
    }
    return this.store(args, 'monitorio_draft', renderMonitorioHtml(data));
  }

  /** Lo común a los tres documentos. */
  private async load(tenantId: string, caseId: string, facilityScope: string[] | null) {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.delinquencyCase.findFirst({
        where: { id: caseId, tenantId },
        include: {
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
              email: true,
              phone: true,
            },
          },
          unit: { select: { code: true } },
          contract: {
            select: {
              contractNumber: true,
              signedAt: true,
              signatures: {
                select: { signerName: true },
                orderBy: { signedAt: 'desc' },
                take: 1,
              },
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
                    select: { name: true, address: true, city: true, timezone: true },
                  },
                },
              },
            },
          },
        },
      });
      if (!row || (facilityScope && row.facilityId && !facilityScope.includes(row.facilityId))) {
        throw new NotFoundException({
          code: 'case_not_found',
          message: 'Expediente no encontrado',
        });
      }
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          name: true,
          billingLegalName: true,
          taxId: true,
          billingAddress: true,
          billingCity: true,
          billingPostalCode: true,
          timezone: true,
        },
      });
      const facility = row.contract.unit?.facility ?? null;
      const tz = facility?.timezone ?? tenant.timezone ?? 'Europe/Madrid';
      const today = todayInTimezone(tz);
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
        .map((i) => ({
          number: i.invoiceNumber,
          issueDate: i.issueDate?.toISOString().slice(0, 10) ?? '',
          dueDate: i.dueDate?.toISOString().slice(0, 10) ?? '',
          totalCents: toCents(i.total),
          pendingCents: Math.max(0, toCents(i.total) - toCents(i.amountPaid)),
        }))
        .filter((i) => i.pendingCents > 0);
      const owner = row.contract.owner;
      const c = row.customer;
      const name =
        c.customerType === 'business'
          ? (c.companyName ?? 'Empresa')
          : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
      const join = (...parts: (string | null | undefined)[]) =>
        parts.filter(Boolean).join(', ') || null;
      const data: CaseDocData = {
        issuer: owner
          ? {
              name: owner.legalName,
              taxId: owner.taxId,
              address: join(
                owner.address,
                [owner.postalCode, owner.city].filter(Boolean).join(' '),
              ),
              managedBy: tenant.name,
            }
          : {
              name: tenant.billingLegalName ?? tenant.name,
              taxId: tenant.taxId,
              address: join(
                tenant.billingAddress,
                [tenant.billingPostalCode, tenant.billingCity].filter(Boolean).join(' '),
              ),
              managedBy: null,
            },
        customer: {
          name,
          document: c.documentNumber
            ? `${c.documentType ? `${c.documentType.toUpperCase()} ` : ''}${c.documentNumber}`
            : null,
          address: c.address,
          city: [c.postalCode, c.city].filter(Boolean).join(' ') || null,
          email: c.email,
          phone: c.phone,
        },
        unitCode: row.unit?.code ?? null,
        facility: facility
          ? { name: facility.name, address: facility.address, city: facility.city }
          : null,
        contract: {
          number: row.contract.contractNumber ?? null,
          signedAt: row.contract.signedAt ? dayLong(row.contract.signedAt) : null,
          signedBy: row.contract.signatures[0]?.signerName ?? null,
        },
        invoices: lines,
        debtCents: lines.reduce((sum, l) => sum + l.pendingCents, 0),
        notice: {
          sentAt: row.finalNoticeAt ? dayLong(row.finalNoticeAt) : null,
          tracking: row.noticeTracking,
          receivedAt: row.noticeReceivedAt ? dayLong(row.noticeReceivedAt) : null,
          deadline: row.finalNoticeDeadline ? dayLong(row.finalNoticeDeadline) : null,
        },
        today: formatDateLong(new Date(), tz),
        place: facility?.city ?? tenant.billingCity ?? null,
      };
      return { data, row };
    }, tenantId);
  }

  /** PDF → MinIO privado → evidencia del expediente + URL firmada. */
  private async store(
    args: { tenantId: string; userId: string; caseId: string },
    kind: 'custody_act' | 'dossier' | 'monitorio_draft',
    html: string,
  ): Promise<{ url: string }> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = Buffer.from(
        await page.pdf({
          format: 'A4',
          margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' },
          printBackground: true,
        }),
      );
      const objectKey = `${args.tenantId}/collections/${args.caseId}/${kind}/${randomUUID()}.pdf`;
      await this.files.putObject({
        bucket: 'uploads',
        key: objectKey,
        body: pdf,
        contentType: 'application/pdf',
      });
      await this.prisma.withTenant(async (tx) => {
        await tx.delinquencyCaseFile.create({
          data: {
            tenantId: args.tenantId,
            caseId: args.caseId,
            kind,
            objectKey,
            contentType: 'application/pdf',
            createdByUserId: args.userId,
          },
        });
        await tx.delinquencyCaseEvent.create({
          data: {
            tenantId: args.tenantId,
            caseId: args.caseId,
            eventType: 'document_generated',
            payload: { kind } as Prisma.InputJsonValue,
            createdByUserId: args.userId,
          },
        });
      }, args.tenantId);
      return { url: await this.files.getPresignedGetUrl('uploads', objectKey) };
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
    const puppeteer = await loadPuppeteer();
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
}

/** Lo que cuenta cada paso del historial, en palabras. */
function eventDetail(type: string, p: Record<string, unknown>): string | null {
  const text = (k: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : null);
  switch (type) {
    case 'notice_sent':
      return (
        [text('tracking') ? `Envío ${text('tracking')}` : null, text('notes')]
          .filter(Boolean)
          .join(' · ') || null
      );
    case 'goods_moved':
      return text('custodyLocation');
    case 'charge_added': {
      const kind = text('kind') as keyof typeof CASE_CHARGE_LABELS | null;
      return kind ? (CASE_CHARGE_LABELS[kind] ?? null) : null;
    }
    case 'document_generated': {
      const kind = text('kind') as CaseFileKind | null;
      return kind ? (CASE_FILE_KIND_LABELS[kind] ?? null) : null;
    }
    default:
      return text('notes') ?? text('reason') ?? text('note');
  }
}
