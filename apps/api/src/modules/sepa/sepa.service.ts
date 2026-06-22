import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaService } from '../database/prisma.service';

import { buildPain008, type Pain008Transaction } from './sepa-pain008';

import type { Prisma } from '@storageos/database';
import type {
  CreateRemittanceInput,
  CreateSepaMandateInput,
  RemittanceEligibleInvoiceDto,
  RemittancePreviewDto,
  SepaMandateDto,
  SepaRemittanceDto,
  SepaSettingsDto,
  UpdateSepaSettingsInput,
} from '@storageos/shared';

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

function rand(n = 8): string {
  return randomBytes(n).toString('hex').toUpperCase().slice(0, n);
}

@Injectable()
export class SepaService {
  private readonly logger = new Logger(SepaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly invoices: InvoicesService,
  ) {}

  // -------------------------------------------------------------------------
  // Config del acreedor
  // -------------------------------------------------------------------------

  async getSettings(tenantId: string): Promise<SepaSettingsDto> {
    const s = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!s) {
      return {
        configured: false,
        creditorName: '',
        creditorId: '',
        creditorIbanLast4: null,
        creditorBic: null,
        enabled: false,
      };
    }
    const iban = this.crypto.decryptString(s.creditorIbanEncrypted);
    return {
      configured: true,
      creditorName: s.creditorName,
      creditorId: s.creditorId,
      creditorIbanLast4: iban.slice(-4),
      creditorBic: s.creditorBic,
      enabled: s.enabled,
    };
  }

  async updateSettings(tenantId: string, input: UpdateSepaSettingsInput): Promise<SepaSettingsDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    // El IBAN es opcional al actualizar: si no se reescribe, se conserva el actual.
    if (!input.creditorIban && !existing) {
      throw new BadRequestException({
        code: 'iban_required',
        message: 'El IBAN del acreedor es obligatorio en la primera configuración',
      });
    }
    const creditorIbanEncrypted = input.creditorIban
      ? this.crypto.encryptString(input.creditorIban)
      : existing!.creditorIbanEncrypted;
    const data = {
      creditorName: input.creditorName,
      creditorId: input.creditorId,
      creditorIbanEncrypted,
      creditorBic: input.creditorBic || null,
      enabled: input.enabled,
    };
    await this.prisma.withTenant(
      (tx) =>
        tx.sepaSettings.upsert({
          where: { tenantId },
          create: { tenantId, ...data },
          update: data,
        }),
      tenantId,
    );
    return this.getSettings(tenantId);
  }

  // -------------------------------------------------------------------------
  // Mandatos
  // -------------------------------------------------------------------------

  private mandateDto(m: {
    id: string;
    customerId: string;
    reference: string;
    ibanLast4: string;
    bic: string | null;
    signedAt: Date;
    sequenceType: string;
    status: string;
    createdAt: Date;
  }): SepaMandateDto {
    return {
      id: m.id,
      customerId: m.customerId,
      reference: m.reference,
      ibanLast4: m.ibanLast4,
      bic: m.bic,
      signedAt: m.signedAt.toISOString().slice(0, 10),
      sequenceType: m.sequenceType as 'FRST' | 'RCUR',
      status: m.status as 'active' | 'cancelled',
      createdAt: m.createdAt.toISOString(),
    };
  }

  async listMandates(tenantId: string, customerId?: string): Promise<SepaMandateDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.sepaMandate.findMany({
          where: { tenantId, ...(customerId ? { customerId } : {}) },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.mandateDto(r));
  }

  async createMandate(tenantId: string, input: CreateSepaMandateInput): Promise<SepaMandateDto> {
    const reference = `MND-${rand(12)}`;
    const created = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Cliente no encontrado',
        });
      }
      // Solo un mandato activo por cliente: cancela el anterior si lo hay.
      await tx.sepaMandate.updateMany({
        where: { customerId: input.customerId, status: 'active' },
        data: { status: 'cancelled' },
      });
      return tx.sepaMandate.create({
        data: {
          tenantId,
          customerId: input.customerId,
          reference,
          ibanEncrypted: this.crypto.encryptString(input.iban),
          ibanLast4: input.iban.slice(-4),
          bic: input.bic || null,
          signedAt: new Date(`${input.signedAt}T00:00:00Z`),
          sequenceType: 'FRST',
          status: 'active',
        },
      });
    }, tenantId);
    return this.mandateDto(created);
  }

  async cancelMandate(tenantId: string, id: string): Promise<void> {
    const res = await this.prisma.withTenant(
      (tx) => tx.sepaMandate.updateMany({ where: { id, tenantId }, data: { status: 'cancelled' } }),
      tenantId,
    );
    if (res.count === 0) {
      throw new NotFoundException({ code: 'mandate_not_found', message: 'Mandato no encontrado' });
    }
  }

  // -------------------------------------------------------------------------
  // Remesas
  // -------------------------------------------------------------------------

  /** Facturas pendientes domiciliables (cliente con mandato activo) y sin remesa. */
  private async eligible(tenantId: string) {
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            status: { in: ['issued', 'overdue'] },
            deletedAt: null,
            sepaRemittanceItem: { is: null },
            customerId: { not: null },
          },
          select: {
            id: true,
            invoiceNumber: true,
            total: true,
            amountPaid: true,
            customerId: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
          },
          orderBy: { invoiceNumber: 'asc' },
        }),
      tenantId,
    );
    const mandates = await this.prisma.withTenant(
      (tx) => tx.sepaMandate.findMany({ where: { tenantId, status: 'active' } }),
      tenantId,
    );
    const byCustomer = new Map(mandates.map((m) => [m.customerId, m]));
    return { invoices, byCustomer };
  }

  async previewRemittance(tenantId: string): Promise<RemittancePreviewDto> {
    const { invoices, byCustomer } = await this.eligible(tenantId);
    const eligible: RemittanceEligibleInvoiceDto[] = [];
    const withoutMandate: RemittancePreviewDto['withoutMandate'] = [];
    for (const inv of invoices) {
      const pending = Math.max(0, Number(inv.total) - Number(inv.amountPaid));
      if (pending <= 0) continue;
      const name = inv.customer ? customerName(inv.customer) : 'Cliente';
      const mandate = inv.customerId ? byCustomer.get(inv.customerId) : undefined;
      if (!mandate) {
        withoutMandate.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customerName: name,
        });
        continue;
      }
      eligible.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerName: name,
        amount: pending,
        mandateReference: mandate.reference,
        ibanLast4: mandate.ibanLast4,
        sequenceType: mandate.sequenceType as 'FRST' | 'RCUR',
      });
    }
    const total = Math.round(eligible.reduce((s, e) => s + e.amount, 0) * 100) / 100;
    return { eligible, total, withoutMandate };
  }

  async createRemittance(args: {
    tenantId: string;
    userId: string;
    input: CreateRemittanceInput;
  }): Promise<SepaRemittanceDto> {
    const { tenantId, input } = args;
    const settings = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!settings) {
      throw new BadRequestException({
        code: 'sepa_not_configured',
        message: 'Configura primero el acreedor SEPA en ajustes',
      });
    }
    const { invoices, byCustomer } = await this.eligible(tenantId);
    const selected = input.invoiceIds
      ? invoices.filter((i) => input.invoiceIds!.includes(i.id))
      : invoices;

    const creditorIban = this.crypto.decryptString(settings.creditorIbanEncrypted);
    const messageId = `REM-${Date.now().toString(36).toUpperCase()}-${rand(6)}`;

    const txs: Pain008Transaction[] = [];
    const items: {
      invoiceId: string;
      mandateId: string;
      amount: number;
      sequenceType: string;
      endToEndId: string;
    }[] = [];
    for (const inv of selected) {
      const pending = Math.max(0, Number(inv.total) - Number(inv.amountPaid));
      if (pending <= 0) continue;
      const mandate = inv.customerId ? byCustomer.get(inv.customerId) : undefined;
      if (!mandate) continue;
      const cents = Math.round(pending * 100);
      const endToEndId = `E2E-${inv.invoiceNumber}`.replace(/[^A-Za-z0-9-]/g, '').slice(0, 35);
      txs.push({
        endToEndId,
        amountCents: cents,
        mandateReference: mandate.reference,
        mandateSignedDate: mandate.signedAt.toISOString().slice(0, 10),
        sequenceType: mandate.sequenceType as 'FRST' | 'RCUR',
        debtorName: inv.customer ? customerName(inv.customer) : 'Cliente',
        debtorIban: this.crypto.decryptString(mandate.ibanEncrypted),
        debtorBic: mandate.bic,
        remittanceInfo: `Factura ${inv.invoiceNumber}`,
      });
      items.push({
        invoiceId: inv.id,
        mandateId: mandate.id,
        amount: cents,
        sequenceType: mandate.sequenceType,
        endToEndId,
      });
    }
    if (txs.length === 0) {
      throw new BadRequestException({
        code: 'no_eligible_invoices',
        message: 'No hay facturas domiciliables con mandato activo',
      });
    }

    const xml = buildPain008({
      messageId,
      creditor: {
        name: settings.creditorName,
        creditorId: settings.creditorId,
        iban: creditorIban,
        bic: settings.creditorBic,
      },
      collectionDate: input.collectionDate,
      transactions: txs,
    });
    const totalCents = items.reduce((s, i) => s + i.amount, 0);

    const created = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittance.create({
          data: {
            tenantId,
            name: input.name,
            messageId,
            collectionDate: new Date(`${input.collectionDate}T00:00:00Z`),
            status: 'generated',
            itemCount: items.length,
            totalAmount: totalCents,
            xml,
            createdByUserId: args.userId,
            items: {
              create: items.map((i) => ({
                tenantId,
                invoiceId: i.invoiceId,
                mandateId: i.mandateId,
                amount: i.amount,
                sequenceType: i.sequenceType,
                endToEndId: i.endToEndId,
              })),
            },
          },
        }),
      tenantId,
    );
    return this.toDto(created);
  }

  async listRemittances(tenantId: string): Promise<SepaRemittanceDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.sepaRemittance.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async getXml(tenantId: string, id: string): Promise<{ filename: string; xml: string }> {
    const r = await this.findOrThrow(tenantId, id);
    if (!r.xml) {
      throw new NotFoundException({ code: 'xml_not_found', message: 'La remesa no tiene XML' });
    }
    return { filename: `remesa-sepa-${r.messageId}.xml`, xml: r.xml };
  }

  /** Confirma el cobro: marca las facturas pagadas y pasa los mandatos a RCUR. */
  async confirmRemittance(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<SepaRemittanceDto> {
    const remittance = await this.findOrThrow(tenantId, id);
    if (remittance.status !== 'generated') {
      throw new BadRequestException({
        code: 'remittance_not_confirmable',
        message: 'La remesa ya está confirmada o cancelada',
      });
    }
    const items = await this.prisma.withTenant(
      (tx) => tx.sepaRemittanceItem.findMany({ where: { remittanceId: id } }),
      tenantId,
    );
    for (const item of items) {
      try {
        await this.invoices.markPaidManually({
          tenantId,
          userId,
          invoiceId: item.invoiceId,
          input: {
            amount: item.amount / 100,
            methodType: 'sepa_debit',
            notes: `Remesa SEPA ${remittance.name}`,
          },
          meta: {},
        });
      } catch (err) {
        this.logger.warn(
          `[sepa] marcar pagada ${item.invoiceId} falló: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // El primer cobro con éxito de un mandato pasa de FRST a RCUR.
    const mandateIds = [...new Set(items.map((i) => i.mandateId))];
    const updated = await this.prisma.withTenant(async (tx) => {
      await tx.sepaMandate.updateMany({
        where: { id: { in: mandateIds }, sequenceType: 'FRST', status: 'active' },
        data: { sequenceType: 'RCUR' },
      });
      return tx.sepaRemittance.update({
        where: { id },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
    }, tenantId);
    return this.toDto(updated);
  }

  private async findOrThrow(tenantId: string, id: string) {
    const row = await this.prisma.withTenant(
      (tx) => tx.sepaRemittance.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'remittance_not_found',
        message: 'Remesa no encontrada',
      });
    }
    return row;
  }

  private toDto(r: Prisma.SepaRemittanceGetPayload<object>): SepaRemittanceDto {
    return {
      id: r.id,
      name: r.name,
      messageId: r.messageId,
      collectionDate: r.collectionDate.toISOString().slice(0, 10),
      status: r.status as SepaRemittanceDto['status'],
      itemCount: r.itemCount,
      total: r.totalAmount / 100,
      createdAt: r.createdAt.toISOString(),
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
    };
  }
}
