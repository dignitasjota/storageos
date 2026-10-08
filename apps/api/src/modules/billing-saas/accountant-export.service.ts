import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ACCOUNTANT_DEPOSIT_COLUMNS,
  ACCOUNTANT_INVOICE_COLUMNS,
  ACCOUNTANT_PAYMENT_COLUMNS,
  defaultTaxCategory,
  withoutActivity,
  type AccountantDepositRow,
  type AccountantExportDto,
  type AccountantExportWarning,
  type AccountantInvoiceRow,
  type AccountantPaymentRow,
  type InvoiceTaxCategory,
  NON_CASH_PAYMENT_METHODS,
} from '@storageos/shared';
import ExcelJS from 'exceljs';

import { PrismaAdminService } from '../database/prisma-admin.service';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const ddmmyyyy = (d: Date): string =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const oneLine = (s: string | null): string | null =>
  s ? s.replace(/\s*\n\s*/g, ', ').trim() || null : null;

const STATUS_LABELS: Record<string, string> = {
  issued: 'Emitida',
  paid: 'Cobrada',
  overdue: 'Vencida',
  cancelled: 'Anulada',
  rectified: 'Rectificada (sustituida)',
  refunded: 'Reembolsada',
  partially_refunded: 'Reembolsada parcialmente',
};

const METHOD_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  stripe: 'Tarjeta (Stripe)',
  sepa_debit: 'Domiciliación SEPA',
  sepa: 'Domiciliación SEPA',
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  paypal: 'PayPal',
  other: 'Otro',
};

/**
 * Exportación para la asesoría de la SL: facturas emitidas y cobros de un
 * periodo, juntando las suscripciones que cobra a los tenants y su propio
 * negocio de trasteros (el tenant marcado como «negocio propio»).
 */
@Injectable()
export class AccountantExportService {
  constructor(private readonly admin: PrismaAdminService) {}

  async build(from: string, to: string): Promise<AccountantExportDto> {
    const fromD = new Date(`${from}T00:00:00.000Z`);
    const toD = new Date(`${to}T23:59:59.999Z`);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD > toD) {
      throw new BadRequestException({ code: 'invalid_range', message: 'Rango de fechas inválido' });
    }
    const settings = await this.admin.platformBillingSettings.findFirst({
      include: { ownTenant: { select: { id: true, name: true } } },
    });
    const own = settings?.ownTenant ?? null;

    const invoices: AccountantInvoiceRow[] = [];
    const payments: AccountantPaymentRow[] = [];
    const deposits: AccountantDepositRow[] = [];
    const warnings: AccountantExportWarning[] = [];

    await this.addSubscriptionInvoices(fromD, toD, invoices, warnings);
    await this.addSubscriptionPayments(fromD, toD, payments);
    if (own) {
      await this.addOwnInvoices(own.id, fromD, toD, invoices, warnings);
      await this.addOwnPayments(own.id, fromD, toD, payments);
      await this.addDeposits(own.id, fromD, toD, deposits);
    }
    return this.sorted({
      from,
      to,
      ownBusinessName: own?.name ?? null,
      invoices,
      payments,
      deposits,
      warnings,
    });
  }

  /**
   * Exportación para la asesoría de UN tenant: sus facturas emitidas (por tipo
   * de IVA), sus cobros y sus fianzas, con los avisos de facturas sin NIF o
   * domicilio del cliente.
   */
  async buildForTenant(tenantId: string, from: string, to: string): Promise<AccountantExportDto> {
    const { fromD, toD } = this.range(from, to);
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    const invoices: AccountantInvoiceRow[] = [];
    const payments: AccountantPaymentRow[] = [];
    const deposits: AccountantDepositRow[] = [];
    const warnings: AccountantExportWarning[] = [];
    await this.addOwnInvoices(tenantId, fromD, toD, invoices, warnings);
    await this.addOwnPayments(tenantId, fromD, toD, payments);
    await this.addDeposits(tenantId, fromD, toD, deposits);
    return this.sorted({
      from,
      to,
      ownBusinessName: tenant.name,
      invoices,
      payments,
      deposits,
      warnings,
    });
  }

  private range(from: string, to: string): { fromD: Date; toD: Date } {
    const fromD = new Date(`${from}T00:00:00.000Z`);
    const toD = new Date(`${to}T23:59:59.999Z`);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD > toD) {
      throw new BadRequestException({ code: 'invalid_range', message: 'Rango de fechas inválido' });
    }
    return { fromD, toD };
  }

  private sorted(dto: AccountantExportDto): AccountantExportDto {
    const byDate = (a: string, b: string) =>
      a.split('/').reverse().join('').localeCompare(b.split('/').reverse().join(''));
    dto.invoices.sort(
      (a, b) => byDate(a.issueDate, b.issueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber),
    );
    dto.payments.sort((a, b) => byDate(a.date, b.date));
    dto.deposits.sort((a, b) => byDate(a.date, b.date));
    return dto;
  }

  /** Excel con hojas de facturas, cobros y fianzas (`single`: sin la columna «Actividad»). */
  async toXlsx(dto: AccountantExportDto, single = false): Promise<Buffer> {
    const cols = <T>(c: { header: string; value: (row: T) => string | number | null }[]) =>
      single ? withoutActivity(c) : c;
    const wb = new ExcelJS.Workbook();
    const addSheet = <T>(
      name: string,
      columns: { header: string; value: (row: T) => string | number | null }[],
      rows: T[],
    ) => {
      const ws = wb.addWorksheet(name);
      ws.addRow(columns.map((c) => c.header)).font = { bold: true };
      for (const row of rows) ws.addRow(columns.map((c) => c.value(row)));
      ws.columns.forEach((col, i) => {
        col.width = Math.max(12, columns[i]!.header.length + 2);
      });
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };
    addSheet('Facturas', cols(ACCOUNTANT_INVOICE_COLUMNS), dto.invoices);
    addSheet('Cobros', cols(ACCOUNTANT_PAYMENT_COLUMNS), dto.payments);
    addSheet('Fianzas', cols(ACCOUNTANT_DEPOSIT_COLUMNS), dto.deposits);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async addSubscriptionInvoices(
    fromD: Date,
    toD: Date,
    out: AccountantInvoiceRow[],
    warnings: AccountantExportWarning[],
  ): Promise<void> {
    const rows = await this.admin.platformInvoice.findMany({
      // Las emitidas por el negocio propio ya salen con sus facturas (sin duplicar).
      where: { issuedAt: { gte: fromD, lte: toD }, invoiceId: null },
      include: { lines: true, rectifiesInvoice: { select: { fullNumber: true } } },
      orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
    });
    for (const inv of rows) {
      const byRate = new Map<number, { base: number; vat: number }>();
      if (inv.lines.length > 0) {
        for (const l of inv.lines) {
          const rate = Number(l.taxRate);
          const prev = byRate.get(rate) ?? { base: 0, vat: 0 };
          byRate.set(rate, {
            base: prev.base + Number(l.baseAmount),
            vat: prev.vat + Number(l.taxAmount),
          });
        }
      } else {
        byRate.set(Number(inv.taxRate), {
          base: Number(inv.baseAmount),
          vat: Number(inv.taxAmount),
        });
      }
      for (const [rate, v] of byRate) {
        out.push({
          source: 'subscriptions',
          invoiceNumber: inv.fullNumber,
          issueDate: ddmmyyyy(inv.issuedAt),
          invoiceType: inv.invoiceType,
          rectifies: inv.rectifiesInvoice?.fullNumber ?? null,
          customerNif: inv.tenantTaxId,
          customerName: inv.tenantName,
          customerAddress: oneLine(inv.tenantAddress),
          taxRate: rate,
          // Las cuotas de la suscripción siempre llevan IVA.
          taxCategory: defaultTaxCategory(rate),
          base: round2(v.base),
          vat: round2(v.vat),
          lineTotal: round2(v.base + v.vat),
          invoiceTotal: round2(Number(inv.total)),
          withholding: 0,
          status: STATUS_LABELS[inv.status] ?? inv.status,
        });
      }
      const missing = [
        ...(inv.tenantTaxId ? [] : ['NIF']),
        ...(inv.tenantAddress ? [] : ['Domicilio']),
      ];
      if (missing.length > 0) {
        warnings.push({ invoiceNumber: inv.fullNumber, source: 'subscriptions', missing });
      }
    }
  }

  private async addSubscriptionPayments(
    fromD: Date,
    toD: Date,
    out: AccountantPaymentRow[],
  ): Promise<void> {
    const rows = await this.admin.tenantSubscriptionPayment.findMany({
      where: {
        status: 'paid',
        paidAt: { gte: fromD, lte: toD },
        // Facturado por el negocio propio: su cobro ya sale con sus facturas.
        ownTenantInvoice: { is: null },
      },
      include: {
        invoice: { select: { fullNumber: true } },
        tenant: { select: { name: true, billingLegalName: true, taxId: true } },
      },
    });
    for (const p of rows) {
      out.push({
        source: 'subscriptions',
        date: ddmmyyyy(p.paidAt!),
        invoiceNumber: p.invoice?.fullNumber ?? null,
        customerNif: p.tenant.taxId,
        customerName: p.tenant.billingLegalName?.trim() || p.tenant.name,
        amount: round2(Number(p.amount)),
        method: METHOD_LABELS[p.provider] ?? p.provider,
        reference: p.externalId,
      });
    }
  }

  private async addOwnInvoices(
    tenantId: string,
    fromD: Date,
    toD: Date,
    out: AccountantInvoiceRow[],
    warnings: AccountantExportWarning[],
  ): Promise<void> {
    const rows = await this.admin.invoice.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { not: 'draft' },
        kind: 'invoice', // los justificantes de fianza no son facturas
        issueDate: { gte: fromD, lte: toD },
      },
      select: {
        invoiceNumber: true,
        issueDate: true,
        invoiceType: true,
        status: true,
        total: true,
        withholdingAmount: true,
        correctionMethod: true,
        rectifiesInvoice: {
          select: {
            invoiceNumber: true,
            total: true,
            items: { select: { taxRate: true, taxCategory: true, taxAmount: true, total: true } },
          },
        },
        customer: {
          select: {
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            documentNumber: true,
            address: true,
            city: true,
            postalCode: true,
          },
        },
        items: { select: { taxRate: true, taxCategory: true, taxAmount: true, total: true } },
      },
      orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
    });
    for (const inv of rows) {
      const c = inv.customer;
      const name = c
        ? c.customerType === 'business'
          ? (c.companyName ?? 'Empresa')
          : [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Cliente'
        : 'Cliente sin identificar (factura simplificada)';
      const address = c?.address
        ? [c.address, [c.postalCode, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
        : null;
      // Una sustitutiva cuenta solo la diferencia con la factura que sustituye.
      const replaced = inv.correctionMethod === 'by_substitution' ? inv.rectifiesInvoice : null;
      // Por tipo y tipo fiscal (exenta y no sujeta, ambas al 0 %, van aparte).
      const byRate = new Map<
        string,
        { rate: number; taxCategory: InvoiceTaxCategory; base: number; vat: number }
      >();
      for (const [items, sign] of [
        [inv.items, 1],
        [replaced?.items ?? [], -1],
      ] as const) {
        for (const item of items) {
          const rate = Number(item.taxRate);
          const taxCategory = item.taxCategory as InvoiceTaxCategory;
          const key = `${rate}|${taxCategory}`;
          const prev = byRate.get(key) ?? { rate, taxCategory, base: 0, vat: 0 };
          prev.base += sign * (Number(item.total) - Number(item.taxAmount));
          prev.vat += sign * Number(item.taxAmount);
          byRate.set(key, prev);
        }
      }
      let first = true;
      for (const v of [...byRate.values()].sort(
        (a, b) => b.rate - a.rate || a.taxCategory.localeCompare(b.taxCategory),
      )) {
        const rate = v.rate;
        const withholding = first ? round2(Number(inv.withholdingAmount)) : 0;
        first = false;
        out.push({
          source: 'own_business',
          withholding,
          invoiceNumber: inv.invoiceNumber,
          issueDate: ddmmyyyy(inv.issueDate ?? fromD),
          invoiceType: inv.invoiceType,
          rectifies: inv.rectifiesInvoice?.invoiceNumber ?? null,
          customerNif: c?.documentNumber ?? null,
          customerName: name,
          customerAddress: address,
          taxRate: rate,
          taxCategory: v.taxCategory,
          base: round2(v.base),
          vat: round2(v.vat),
          lineTotal: round2(v.base + v.vat),
          invoiceTotal: round2(Number(inv.total) - (replaced ? Number(replaced.total) : 0)),
          status: STATUS_LABELS[inv.status] ?? inv.status,
        });
      }
      // Una factura completa (no simplificada) necesita NIF y domicilio del cliente.
      if (inv.invoiceType !== 'F2') {
        const missing = [
          ...(c?.documentNumber ? [] : ['NIF']),
          ...(c?.address ? [] : ['Domicilio']),
        ];
        if (missing.length > 0) {
          warnings.push({ invoiceNumber: inv.invoiceNumber, source: 'own_business', missing });
        }
      }
    }
  }

  private async addOwnPayments(
    tenantId: string,
    fromD: Date,
    toD: Date,
    out: AccountantPaymentRow[],
  ): Promise<void> {
    const rows = await this.admin.payment.findMany({
      where: {
        tenantId,
        methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] }, // una compensación con abono no es dinero cobrado
        // Las fianzas no son ingresos: van en su propia hoja.
        NOT: { invoice: { kind: 'deposit_receipt' } },
        OR: [
          {
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: fromD, lte: toD },
          },
          { refundedAt: { gte: fromD, lte: toD }, refundedAmount: { gt: 0 } },
        ],
      },
      include: {
        invoice: { select: { invoiceNumber: true } },
        customer: {
          select: {
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            documentNumber: true,
          },
        },
      },
    });
    for (const p of rows) {
      const c = p.customer;
      const name = !c
        ? 'Cliente sin identificar (factura simplificada)'
        : c.customerType === 'business'
          ? (c.companyName ?? 'Empresa')
          : [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Cliente';
      const base = {
        source: 'own_business' as const,
        invoiceNumber: p.invoice?.invoiceNumber ?? null,
        customerNif: c?.documentNumber ?? null,
        customerName: name,
        method: METHOD_LABELS[p.methodType] ?? p.methodType,
        reference: p.gatewayPaymentId,
      };
      if (p.paidAt && p.paidAt >= fromD && p.paidAt <= toD) {
        out.push({ ...base, date: ddmmyyyy(p.paidAt), amount: round2(Number(p.amount)) });
      }
      // La devolución va como una fila aparte, en negativo y en su fecha.
      if (
        p.refundedAt &&
        p.refundedAt >= fromD &&
        p.refundedAt <= toD &&
        Number(p.refundedAmount) > 0
      ) {
        out.push({
          ...base,
          date: ddmmyyyy(p.refundedAt),
          amount: -round2(Number(p.refundedAmount)),
          method: `Devolución (${base.method})`,
        });
      }
    }
  }

  /** Fianzas: recibidas (cobro del justificante), devueltas y retenidas (al liquidar). */
  private async addDeposits(
    tenantId: string,
    fromD: Date,
    toD: Date,
    out: AccountantDepositRow[],
  ): Promise<void> {
    const name = (
      c: {
        customerType: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      } | null,
    ) =>
      !c
        ? 'Cliente'
        : c.customerType === 'business'
          ? (c.companyName ?? 'Empresa')
          : [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Cliente';
    const customerSelect = {
      customerType: true,
      firstName: true,
      lastName: true,
      companyName: true,
      documentNumber: true,
    } as const;

    const received = await this.admin.payment.findMany({
      where: {
        tenantId,
        invoice: { kind: 'deposit_receipt' },
        OR: [
          {
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: fromD, lte: toD },
          },
          { refundedAt: { gte: fromD, lte: toD }, refundedAmount: { gt: 0 } },
        ],
      },
      include: {
        invoice: {
          select: { invoiceNumber: true, contract: { select: { contractNumber: true } } },
        },
        customer: { select: customerSelect },
      },
    });
    for (const p of received) {
      const base = {
        source: 'own_business' as const,
        document: p.invoice?.invoiceNumber ?? '',
        contractNumber: p.invoice?.contract?.contractNumber ?? null,
        customerNif: p.customer?.documentNumber ?? null,
        customerName: name(p.customer),
      };
      if (p.paidAt && p.paidAt >= fromD && p.paidAt <= toD) {
        out.push({
          ...base,
          date: ddmmyyyy(p.paidAt),
          movement: 'received',
          amount: round2(Number(p.amount)),
          detail: METHOD_LABELS[p.methodType] ?? p.methodType,
        });
      }
      if (p.refundedAt && p.refundedAt >= fromD && p.refundedAt <= toD) {
        out.push({
          ...base,
          date: ddmmyyyy(p.refundedAt),
          movement: 'returned',
          amount: -round2(Number(p.refundedAmount)),
          detail: 'Reembolso del cobro',
        });
      }
    }

    // Liquidación al terminar el contrato: lo devuelto y lo que se queda el negocio.
    const settled = await this.admin.contract.findMany({
      where: { tenantId, depositSettledAt: { gte: fromD, lte: toD }, depositAmount: { gt: 0 } },
      select: {
        contractNumber: true,
        depositAmount: true,
        depositReturnedAmount: true,
        depositSettledAt: true,
        depositRetentionReason: true,
        customer: { select: customerSelect },
      },
    });
    for (const c of settled) {
      const returned = round2(Number(c.depositReturnedAmount ?? 0));
      const retained = round2(Number(c.depositAmount) - returned);
      const base = {
        source: 'own_business' as const,
        date: ddmmyyyy(c.depositSettledAt!),
        document: c.contractNumber,
        contractNumber: c.contractNumber,
        customerNif: c.customer?.documentNumber ?? null,
        customerName: name(c.customer),
      };
      if (returned > 0) {
        out.push({ ...base, movement: 'returned', amount: -returned, detail: null });
      }
      if (retained > 0) {
        out.push({
          ...base,
          movement: 'retained',
          amount: retained,
          detail: c.depositRetentionReason,
        });
      }
    }
  }
}
