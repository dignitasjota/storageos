import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { CryptoService } from '../../common/crypto/crypto.service';
import { subtractAmounts, toCents } from '../../common/money';
import { DOMAIN_EVENTS, type SepaRemittanceCreatedPayload } from '../automations/domain-events';
import { InvoicesService, lockInvoiceRow } from '../billing/invoices.service';
import { PrismaService } from '../database/prisma.service';

import { buildPain008, type Pain008Transaction } from './sepa-pain008';

import type { Prisma } from '@storageos/database';
import type {
  ConfirmRemittanceInput,
  CreateRemittanceInput,
  CreateSepaMandateInput,
  RemittanceEligibleInvoiceDto,
  RemittancePreviewDto,
  SepaMandateDto,
  SepaPrenoticeStatus,
  SepaRemittanceItemStatus,
  SepaRemittanceDto,
  SepaRemittancePrenoticeDto,
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

type ItemStatusCounts = { collected: number; failed: number; returned: number };

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
    private readonly events: EventEmitter2,
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
        prenoticeDays: 14,
        enabled: false,
      };
    }
    const iban = this.crypto.decryptString(s.creditorIbanEncrypted, tenantId);
    return {
      configured: true,
      creditorName: s.creditorName,
      creditorId: s.creditorId,
      creditorIbanLast4: iban.slice(-4),
      creditorBic: s.creditorBic,
      prenoticeDays: s.prenoticeDays,
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
      ? this.crypto.encryptString(input.creditorIban, tenantId)
      : existing!.creditorIbanEncrypted;
    const data = {
      creditorName: input.creditorName,
      creditorId: input.creditorId,
      creditorIbanEncrypted,
      creditorBic: input.creditorBic || null,
      prenoticeDays: input.prenoticeDays,
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
          ibanEncrypted: this.crypto.encryptString(input.iban, tenantId),
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
            // Ni en otra remesa viva ni con un cobro por pasarela en curso.
            sepaRemittanceItems: { none: { status: { in: ['pending', 'collected'] } } },
            payments: { none: { status: { in: ['pending', 'processing'] } } },
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
      const pending = Math.max(0, subtractAmounts(inv.total, inv.amountPaid));
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
    // Suma en céntimos enteros (sumar decimales acumula drift antes del redondeo).
    const total = eligible.reduce((s, e) => s + toCents(e.amount), 0) / 100;
    const settings = await this.prisma.withTenant(
      (tx) => tx.sepaSettings.findUnique({ where: { tenantId }, select: { prenoticeDays: true } }),
      tenantId,
    );
    return { eligible, total, withoutMandate, prenoticeDays: settings?.prenoticeDays ?? 14 };
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

    const creditorIban = this.crypto.decryptString(settings.creditorIbanEncrypted, tenantId);
    const messageId = `REM-${Date.now().toString(36).toUpperCase()}-${rand(6)}`;

    // Se bloquean las facturas (en orden, sin interbloqueos) y se vuelven a
    // comprobar dentro de la transacción: un cobro, otra remesa o una
    // anulación que llegue a la vez no acaba también en el fichero del banco.
    const created = await this.prisma.withTenant(
      async (tx) => {
        const ids = selected.map((i) => i.id).sort();
        for (const id of ids) await lockInvoiceRow(tx, id);
        const fresh = await tx.invoice.findMany({
          where: {
            id: { in: ids },
            status: { in: ['issued', 'overdue'] },
            deletedAt: null,
            sepaRemittanceItems: { none: { status: { in: ['pending', 'collected'] } } },
            payments: { none: { status: { in: ['pending', 'processing'] } } },
          },
          select: { id: true, total: true, amountPaid: true },
        });
        const freshById = new Map(fresh.map((f) => [f.id, f]));

        const txs: Pain008Transaction[] = [];
        const items: {
          invoiceId: string;
          mandateId: string;
          amount: number;
          sequenceType: string;
          endToEndId: string;
        }[] = [];
        for (const inv of selected) {
          const now = freshById.get(inv.id);
          if (!now) continue;
          const pending = Math.max(0, subtractAmounts(now.total, now.amountPaid));
          if (pending <= 0) continue;
          const mandate = inv.customerId ? byCustomer.get(inv.customerId) : undefined;
          if (!mandate) continue;
          const cents = toCents(pending);
          // Sufijo por remesa: una factura devuelta y presentada otra vez lleva
          // otra referencia de adeudo.
          const endToEndId = `E2E-${inv.invoiceNumber}-${rand(4)}`
            .replace(/[^A-Za-z0-9-]/g, '')
            .slice(0, 35);
          txs.push({
            endToEndId,
            amountCents: cents,
            mandateReference: mandate.reference,
            mandateSignedDate: mandate.signedAt.toISOString().slice(0, 10),
            sequenceType: mandate.sequenceType as 'FRST' | 'RCUR',
            debtorName: inv.customer ? customerName(inv.customer) : 'Cliente',
            debtorIban: this.crypto.decryptString(mandate.ibanEncrypted, tenantId),
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
        const totalCents = items.reduce((sum, i) => sum + i.amount, 0);

        return tx.sepaRemittance.create({
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
        });
      },
      tenantId,
      { timeout: 30_000 },
    );
    // Preaviso de cargo a cada deudor (lo envía CustomerEmailsService).
    this.events.emit(DOMAIN_EVENTS.sepa_remittance_created, {
      tenantId,
      remittanceId: created.id,
    } satisfies SepaRemittanceCreatedPayload);
    return this.toDto(created);
  }

  async listRemittances(tenantId: string): Promise<SepaRemittanceDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.sepaRemittance.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    const ids = rows.map((r) => r.id);
    const [counts, status] = await Promise.all([
      this.prenoticeCounts(tenantId, ids),
      this.itemStatusCounts(tenantId, ids),
    ]);
    return rows.map((r) => this.toDto(r, counts.get(r.id), status.get(r.id)));
  }

  /** Constancia del preaviso de cada adeudo de la remesa. */
  async listPrenotices(tenantId: string, id: string): Promise<SepaRemittancePrenoticeDto[]> {
    await this.findOrThrow(tenantId, id);
    const items = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.findMany({
          where: { remittanceId: id },
          include: {
            invoice: { select: { invoiceNumber: true } },
            mandate: {
              select: {
                customerId: true,
                customer: {
                  select: {
                    customerType: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
              },
            },
            prenoticeCommunication: { select: { status: true } },
          },
          orderBy: { id: 'asc' },
        }),
      tenantId,
    );
    return items.map((i) => {
      const c = i.mandate.customer;
      return {
        itemId: i.id,
        invoiceId: i.invoiceId,
        invoiceNumber: i.invoice.invoiceNumber,
        customerId: i.mandate.customerId,
        customerName:
          c.customerType === 'business'
            ? (c.companyName ?? '')
            : [c.firstName, c.lastName].filter(Boolean).join(' '),
        amount: i.amount / 100,
        status: i.prenoticeStatus as SepaPrenoticeStatus | null,
        at: i.prenoticeAt?.toISOString() ?? null,
        recipient: i.prenoticeRecipient,
        subject: i.prenoticeSubject,
        text: i.prenoticeText,
        deliveryStatus: i.prenoticeCommunication?.status ?? null,
        itemStatus: i.status as SepaRemittanceItemStatus,
        failureReason: i.failureReason,
      };
    });
  }

  private async prenoticeCounts(
    tenantId: string,
    remittanceIds: string[],
  ): Promise<Map<string, { sent: number; missing: number }>> {
    const out = new Map<string, { sent: number; missing: number }>();
    if (remittanceIds.length === 0) return out;
    const groups = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.groupBy({
          by: ['remittanceId', 'prenoticeStatus'],
          where: { remittanceId: { in: remittanceIds } },
          _count: { _all: true },
        }),
      tenantId,
    );
    for (const g of groups) {
      const cur = out.get(g.remittanceId) ?? { sent: 0, missing: 0 };
      if (g.prenoticeStatus === 'sent') cur.sent += g._count._all;
      else if (g.prenoticeStatus) cur.missing += g._count._all;
      out.set(g.remittanceId, cur);
    }
    return out;
  }

  /** Adeudos cobrados, fallidos y devueltos por remesa. */
  private async itemStatusCounts(
    tenantId: string,
    remittanceIds: string[],
  ): Promise<Map<string, ItemStatusCounts>> {
    const out = new Map<string, ItemStatusCounts>();
    if (remittanceIds.length === 0) return out;
    const groups = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.groupBy({
          by: ['remittanceId', 'status'],
          where: { remittanceId: { in: remittanceIds } },
          _count: { _all: true },
        }),
      tenantId,
    );
    for (const g of groups) {
      const cur = out.get(g.remittanceId) ?? { collected: 0, failed: 0, returned: 0 };
      if (g.status === 'collected' || g.status === 'failed' || g.status === 'returned') {
        cur[g.status] += g._count._all;
      }
      out.set(g.remittanceId, cur);
    }
    return out;
  }

  async getXml(tenantId: string, id: string): Promise<{ filename: string; xml: string }> {
    const r = await this.findOrThrow(tenantId, id);
    if (!r.xml) {
      throw new NotFoundException({ code: 'xml_not_found', message: 'La remesa no tiene XML' });
    }
    return { filename: `remesa-sepa-${r.messageId}.xml`, xml: r.xml };
  }

  /**
   * Confirma el cobro: cada adeudo pasa a cobrado (factura pagada) o a fallido
   * (rechazado por el banco, o la factura ya estaba pagada por otra vía); los
   * mandatos con algún cobro pasan de FRST a RCUR.
   */
  async confirmRemittance(
    tenantId: string,
    userId: string,
    id: string,
    input: ConfirmRemittanceInput = {},
  ): Promise<SepaRemittanceDto> {
    const remittance = await this.findOrThrow(tenantId, id);
    // Reclamar la remesa ANTES de cobrar sus facturas: un doble clic en
    // «Confirmar cobro» no registra dos veces cada cobro; el segundo recibe 400.
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittance.updateMany({
          where: { id, tenantId, status: 'generated' },
          data: { status: 'confirmed', confirmedAt: new Date() },
        }),
      tenantId,
    );
    if (count === 0) {
      throw new BadRequestException({
        code: 'remittance_not_confirmable',
        message: 'La remesa ya está confirmada o cancelada',
      });
    }
    const rejected = new Set(input.rejectedItemIds ?? []);
    const items = await this.prisma.withTenant(
      (tx) => tx.sepaRemittanceItem.findMany({ where: { remittanceId: id, status: 'pending' } }),
      tenantId,
    );
    const collectedMandates = new Set<string>();
    for (const item of items) {
      if (rejected.has(item.id)) {
        await this.setItemStatus(tenantId, item.id, 'failed', 'Rechazado por el banco');
        continue;
      }
      try {
        await this.invoices.markPaidManually({
          tenantId,
          userId,
          invoiceId: item.invoiceId,
          input: {
            amount: item.amount / 100,
            methodType: 'sepa_debit',
            notes: `Remesa SEPA ${remittance.name}`,
            // Confirmación de un cobro real por remesa: salta el guard de adeudo en vuelo.
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
            allowPartialNonCash: true,
          },
          meta: {},
        });
        await this.setItemStatus(tenantId, item.id, 'collected', null);
        collectedMandates.add(item.mandateId);
      } catch (err) {
        // P. ej. la factura ya se pagó por otra vía (efectivo, transferencia):
        // el banco la ha cobrado igualmente → hay que devolver ese importe.
        const reason = err instanceof Error ? err.message : 'No se pudo registrar el cobro';
        this.logger.warn(`[sepa] adeudo ${item.id} (factura ${item.invoiceId}) falló: ${reason}`);
        await this.setItemStatus(tenantId, item.id, 'failed', reason);
      }
    }
    // El primer cobro con éxito de un mandato pasa de FRST a RCUR.
    const updated = await this.prisma.withTenant(async (tx) => {
      if (collectedMandates.size > 0) {
        await tx.sepaMandate.updateMany({
          where: { id: { in: [...collectedMandates] }, sequenceType: 'FRST', status: 'active' },
          data: { sequenceType: 'RCUR' },
        });
      }
      return tx.sepaRemittance.findUniqueOrThrow({ where: { id } });
    }, tenantId);
    return this.dtoWithCounts(tenantId, updated);
  }

  /**
   * Cancela una remesa generada y aún sin confirmar (no se llegó a enviar al
   * banco, o el banco la rechazó entera): sus facturas vuelven a poder cobrarse
   * y a entrar en otra remesa.
   */
  async cancelRemittance(tenantId: string, id: string): Promise<SepaRemittanceDto> {
    await this.findOrThrow(tenantId, id);
    const updated = await this.prisma.withTenant(async (tx) => {
      const { count } = await tx.sepaRemittance.updateMany({
        where: { id, tenantId, status: 'generated' },
        data: { status: 'cancelled' },
      });
      if (count === 0) {
        throw new BadRequestException({
          code: 'remittance_not_cancellable',
          message: 'Solo se puede cancelar una remesa sin confirmar',
        });
      }
      await tx.sepaRemittanceItem.updateMany({
        where: { remittanceId: id, status: 'pending' },
        data: { status: 'cancelled' },
      });
      return tx.sepaRemittance.findUniqueOrThrow({ where: { id } });
    }, tenantId);
    return this.dtoWithCounts(tenantId, updated);
  }

  private async setItemStatus(
    tenantId: string,
    itemId: string,
    status: 'collected' | 'failed',
    failureReason: string | null,
  ): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.sepaRemittanceItem.update({ where: { id: itemId }, data: { status, failureReason } }),
      tenantId,
    );
  }

  private async dtoWithCounts(
    tenantId: string,
    r: Prisma.SepaRemittanceGetPayload<object>,
  ): Promise<SepaRemittanceDto> {
    const counts = await this.prenoticeCounts(tenantId, [r.id]);
    const status = await this.itemStatusCounts(tenantId, [r.id]);
    return this.toDto(r, counts.get(r.id), status.get(r.id));
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

  private toDto(
    r: Prisma.SepaRemittanceGetPayload<object>,
    counts: { sent: number; missing: number } = { sent: 0, missing: 0 },
    items: ItemStatusCounts = { collected: 0, failed: 0, returned: 0 },
  ): SepaRemittanceDto {
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
      prenoticesSent: counts.sent,
      prenoticesMissing: counts.missing,
      collectedCount: items.collected,
      failedCount: items.failed,
      returnedCount: items.returned,
    };
  }
}
