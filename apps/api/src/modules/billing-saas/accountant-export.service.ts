import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ACCOUNTANT_INVOICE_COLUMNS,
  ACCOUNTANT_PAYMENT_COLUMNS,
  type AccountantExportDto,
  type AccountantExportWarning,
  type AccountantInvoiceRow,
  type AccountantPaymentRow,
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
    const warnings: AccountantExportWarning[] = [];

    await this.addSubscriptionInvoices(fromD, toD, invoices, warnings);
    await this.addSubscriptionPayments(fromD, toD, payments);
    if (own) {
      await this.addOwnInvoices(own.id, fromD, toD, invoices, warnings);
      await this.addOwnPayments(own.id, fromD, toD, payments);
    }

    const byDate = (a: string, b: string) =>
      a.split('/').reverse().join('').localeCompare(b.split('/').reverse().join(''));
    invoices.sort(
      (a, b) => byDate(a.issueDate, b.issueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber),
    );
    payments.sort((a, b) => byDate(a.date, b.date));

    return { from, to, ownBusinessName: own?.name ?? null, invoices, payments, warnings };
  }

  /** Excel con una hoja de facturas y otra de cobros. */
  async toXlsx(dto: AccountantExportDto): Promise<Buffer> {
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
    addSheet('Facturas', ACCOUNTANT_INVOICE_COLUMNS, dto.invoices);
    addSheet('Cobros', ACCOUNTANT_PAYMENT_COLUMNS, dto.payments);
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
          base: round2(v.base),
          vat: round2(v.vat),
          lineTotal: round2(v.base + v.vat),
          invoiceTotal: round2(Number(inv.total)),
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
        correctionMethod: true,
        rectifiesInvoice: {
          select: {
            invoiceNumber: true,
            total: true,
            items: { select: { taxRate: true, taxAmount: true, total: true } },
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
        items: { select: { taxRate: true, taxAmount: true, total: true } },
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
      const byRate = new Map<number, { base: number; vat: number }>();
      for (const [items, sign] of [
        [inv.items, 1],
        [replaced?.items ?? [], -1],
      ] as const) {
        for (const item of items) {
          const rate = Number(item.taxRate);
          const prev = byRate.get(rate) ?? { base: 0, vat: 0 };
          byRate.set(rate, {
            base: prev.base + sign * (Number(item.total) - Number(item.taxAmount)),
            vat: prev.vat + sign * Number(item.taxAmount),
          });
        }
      }
      for (const [rate, v] of [...byRate.entries()].sort((a, b) => b[0] - a[0])) {
        out.push({
          source: 'own_business',
          invoiceNumber: inv.invoiceNumber,
          issueDate: ddmmyyyy(inv.issueDate ?? fromD),
          invoiceType: inv.invoiceType,
          rectifies: inv.rectifiesInvoice?.invoiceNumber ?? null,
          customerNif: c?.documentNumber ?? null,
          customerName: name,
          customerAddress: address,
          taxRate: rate,
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
        methodType: { not: 'credit_note' }, // una compensación con abono no es dinero cobrado
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
}
