import { BadRequestException, Injectable } from '@nestjs/common';
import {
  MODEL_347_THRESHOLD,
  expenseCategoryLabel,
  type ReceivedInvoicesBookDto,
  type WithholdingModelDto,
  type WithholdingsDto,
} from '@storageos/shared';

import { rectifiedStatusLabel } from '../billing/rectified-status';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  AccountingExportDto,
  AccountingExportRow,
  InvoiceTaxCategory,
  Model303Dto,
  Model347Dto,
  Model347Row,
  Model347SupplierRow,
  VatBookDto,
} from '@storageos/shared';

/**
 * Gastos de un emisor: los del negocio (generales o de locales sin
 * propietario) o los de los locales de un propietario (plan Administrador).
 */
export function ownerExpenseWhere(ownerId: string | null): Prisma.ExpenseWhereInput {
  return ownerId
    ? { facility: { ownerId } }
    : { OR: [{ facilityId: null }, { facility: { ownerId: null } }] };
}

/** Estados que cuentan a efectos fiscales (devengo): todo salvo borrador/anulada. */
const FISCAL_STATUSES = [
  'issued',
  'paid',
  'overdue',
  'refunded',
  'partially_refunded',
  // Anulada con rectificativa: sigue contando; la rectificativa de abono resta.
  'rectified',
] as const;

function customerName(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return 'Sin cliente (F2)';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** NIF sin espacios ni guiones y en mayúsculas (para agrupar el 347). */
function normalizeNif(nif: string): string {
  return nif.replace(/[\s.-]/g, '').toUpperCase();
}

/**
 * NIF del cliente tal como estaba al emitir; las facturas anteriores a guardarlo
 * usan el de la ficha.
 */
function snapshotNif(inv: {
  customerTaxIdSnapshot: string | null;
  customerNameSnapshot: string | null;
  customer: { documentNumber: string | null } | null;
}): string | null {
  if (inv.customerNameSnapshot !== null) return inv.customerTaxIdSnapshot;
  return inv.customer?.documentNumber ?? null;
}

const STATUS_LABELS: Record<string, string> = {
  issued: 'Pendiente',
  paid: 'Pagada',
  overdue: 'Vencida',
  refunded: 'Reembolsada',
  partially_refunded: 'Reembolsada (parcial)',
};

function parseRange(from: string, to: string): { fromD: Date; toD: Date } {
  const fromD = new Date(`${from}T00:00:00Z`);
  const toD = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD > toD) {
    throw new BadRequestException({ code: 'invalid_range', message: 'Rango de fechas no válido' });
  }
  return { fromD, toD };
}

/** `DD/MM/AAAA` — formato de fecha habitual en la importación de software contable español. */
function ddmmyyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

type Amount = { toString(): string } | number;
interface FiscalItem {
  taxRate: Amount;
  taxCategory: string;
  taxAmount: Amount;
  total: Amount;
}

type RateGroup = { rate: number; taxCategory: InvoiceTaxCategory; base: number; vat: number };

/** Suma una línea a su grupo (tipo + tipo fiscal: exenta y no sujeta, ambas al 0 %, van aparte). */
function addLine(out: Map<string, RateGroup>, item: FiscalItem, sign: number): void {
  const rate = Number(item.taxRate);
  const taxCategory = item.taxCategory as InvoiceTaxCategory;
  const key = `${rate}|${taxCategory}`;
  const prev = out.get(key) ?? { rate, taxCategory, base: 0, vat: 0 };
  prev.base += sign * (Number(item.total) - Number(item.taxAmount));
  prev.vat += sign * Number(item.taxAmount);
  out.set(key, prev);
}

function sortedGroups(groups: Iterable<RateGroup>): RateGroup[] {
  return [...groups]
    .map((g) => ({ ...g, base: round2(g.base), vat: round2(g.vat) }))
    .sort((a, b) => b.rate - a.rate || a.taxCategory.localeCompare(b.taxCategory));
}
interface FiscalDoc {
  items: FiscalItem[];
  correctionMethod: string | null;
  rectifiesInvoice: {
    subtotal: Amount;
    taxAmount: Amount;
    total: Amount;
    items: FiscalItem[];
  } | null;
}

/**
 * Factura sustituida por una rectificativa por sustitución: la sustitutiva
 * lleva los importes completos, así que en los informes cuenta solo la
 * diferencia (si no, la base salía dos veces).
 */
function substituted(inv: FiscalDoc): FiscalDoc['rectifiesInvoice'] {
  return inv.correctionMethod === 'by_substitution' ? inv.rectifiesInvoice : null;
}

/** Base y cuota por tipo de IVA y tipo fiscal, neto de la factura sustituida. */
function netByRate(inv: FiscalDoc): Map<string, RateGroup> {
  const out = new Map<string, RateGroup>();
  for (const item of inv.items) addLine(out, item, 1);
  const sub = substituted(inv);
  if (sub) for (const item of sub.items) addLine(out, item, -1);
  return out;
}

export function quarterRange(year: number, quarter: number): { from: Date; to: Date } {
  const startMonth = (quarter - 1) * 3;
  return {
    from: new Date(Date.UTC(year, startMonth, 1)),
    to: new Date(Date.UTC(year, startMonth + 3, 0)),
  };
}

@Injectable()
export class FiscalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Libro registro de facturas expedidas (IVA emitido) en un rango de fechas. */
  async vatBook(
    tenantId: string,
    from: string,
    to: string,
    ownerId: string | null = null,
  ): Promise<VatBookDto> {
    const { fromD, toD } = parseRange(from, to);
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            deletedAt: null,
            ownerId,
            status: { in: [...FISCAL_STATUSES] },
            kind: 'invoice', // los justificantes de fianza no son facturas
            issueDate: { gte: fromD, lte: toD },
          },
          select: {
            invoiceNumber: true,
            issueDate: true,
            invoiceType: true,
            subtotal: true,
            taxAmount: true,
            total: true,
            customerNameSnapshot: true,
            customerTaxIdSnapshot: true,
            customer: {
              select: {
                customerType: true,
                firstName: true,
                lastName: true,
                companyName: true,
                documentNumber: true,
              },
            },
            items: { select: { taxRate: true, taxCategory: true, taxAmount: true, total: true } },
            correctionMethod: true,
            rectifiesInvoice: {
              select: {
                subtotal: true,
                taxAmount: true,
                total: true,
                items: {
                  select: { taxRate: true, taxCategory: true, taxAmount: true, total: true },
                },
              },
            },
          },
          orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
        }),
      tenantId,
    );

    const byRateMap = new Map<string, RateGroup>();
    let totalBase = 0;
    let totalVat = 0;
    let totalTotal = 0;

    const rows = invoices.map((inv) => {
      const sub = substituted(inv);
      const base = Number(inv.subtotal) - (sub ? Number(sub.subtotal) : 0);
      const vat = Number(inv.taxAmount) - (sub ? Number(sub.taxAmount) : 0);
      const total = Number(inv.total) - (sub ? Number(sub.total) : 0);
      totalBase += base;
      totalVat += vat;
      totalTotal += total;
      for (const [key, v] of netByRate(inv)) {
        const prev = byRateMap.get(key) ?? { ...v, base: 0, vat: 0 };
        prev.base += v.base;
        prev.vat += v.vat;
        byRateMap.set(key, prev);
      }
      return {
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDate ? inv.issueDate.toISOString().slice(0, 10) : null,
        invoiceType: inv.invoiceType,
        customerName: inv.customerNameSnapshot ?? customerName(inv.customer),
        customerNif: snapshotNif(inv),
        base: round2(base),
        vat: round2(vat),
        total: round2(total),
      };
    });

    const byRate = sortedGroups(byRateMap.values());

    return {
      from,
      to,
      rows,
      byRate,
      totals: { base: round2(totalBase), vat: round2(totalVat), total: round2(totalTotal) },
    };
  }

  /** Modelo 303 — IVA devengado (repercutido) por tipo, de un trimestre. */
  async model303(
    tenantId: string,
    year: number,
    quarter: number,
    ownerId: string | null = null,
  ): Promise<Model303Dto> {
    if (quarter < 1 || quarter > 4) {
      throw new BadRequestException({ code: 'invalid_quarter', message: 'Trimestre 1-4' });
    }
    const { from, to } = quarterRange(year, quarter);
    const items = await this.prisma.withTenant(
      (tx) =>
        tx.invoiceItem.findMany({
          where: {
            tenantId,
            invoice: {
              deletedAt: null,
              ownerId,
              status: { in: [...FISCAL_STATUSES] },
              kind: 'invoice', // los justificantes de fianza no son facturas
              issueDate: { gte: from, lte: to },
            },
          },
          select: { taxRate: true, taxCategory: true, taxAmount: true, total: true },
        }),
      tenantId,
    );
    // Las sustitutivas declaran solo la diferencia con la factura sustituida.
    const replaced = await this.prisma.withTenant(
      (tx) =>
        tx.invoiceItem.findMany({
          where: {
            tenantId,
            invoice: {
              rectifiedBy: {
                some: {
                  ownerId,
                  correctionMethod: 'by_substitution',
                  deletedAt: null,
                  status: { in: [...FISCAL_STATUSES] },
                  issueDate: { gte: from, lte: to },
                },
              },
            },
          },
          select: { taxRate: true, taxCategory: true, taxAmount: true, total: true },
        }),
      tenantId,
    );
    const byRateMap = new Map<string, RateGroup>();
    for (const [list, sign] of [
      [items, 1],
      [replaced, -1],
    ] as const) {
      for (const item of list) addLine(byRateMap, item, sign);
    }
    const byRate = sortedGroups(byRateMap.values());

    const invoiceCount = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.count({
          where: {
            tenantId,
            deletedAt: null,
            ownerId,
            status: { in: [...FISCAL_STATUSES] },
            kind: 'invoice', // los justificantes de fianza no son facturas
            issueDate: { gte: from, lte: to },
          },
        }),
      tenantId,
    );

    // IVA soportado deducible: gastos desglosados del trimestre.
    const [received, unbroken] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.expense.findMany({
            where: {
              ...ownerExpenseWhere(ownerId),
              baseAmount: { not: null },
              vatDeductible: true,
              expenseDate: { gte: from, lte: to },
            },
            select: { baseAmount: true, vatRate: true, vatAmount: true },
          }),
          tx.expense.aggregate({
            where: {
              ...ownerExpenseWhere(ownerId),
              baseAmount: null,
              expenseDate: { gte: from, lte: to },
            },
            _count: { _all: true },
            _sum: { amount: true },
          }),
        ]),
      tenantId,
    );
    const receivedByRate = new Map<number, { rate: number; base: number; vat: number }>();
    for (const e of received) {
      const rate = Number(e.vatRate ?? 0);
      if (rate <= 0) continue;
      const g = receivedByRate.get(rate) ?? { rate, base: 0, vat: 0 };
      g.base += Number(e.baseAmount ?? 0);
      g.vat += Number(e.vatAmount ?? 0);
      receivedByRate.set(rate, g);
    }
    const receivedRows = [...receivedByRate.values()]
      .map((g) => ({ rate: g.rate, base: round2(g.base), vat: round2(g.vat) }))
      .sort((a, b) => b.rate - a.rate);
    const totalVat = round2(byRate.reduce((s, r) => s + r.vat, 0));
    const receivedVat = round2(receivedRows.reduce((s, r) => s + r.vat, 0));

    return {
      year,
      quarter,
      byRate,
      totalBase: round2(byRate.reduce((s, r) => s + r.base, 0)),
      totalVat,
      invoiceCount,
      received: {
        byRate: receivedRows,
        base: round2(receivedRows.reduce((s, r) => s + r.base, 0)),
        vat: receivedVat,
        count: received.filter((e) => Number(e.vatRate ?? 0) > 0).length,
      },
      unbroken: {
        count: unbroken._count._all,
        amount: round2(Number(unbroken._sum.amount ?? 0)),
      },
      result: round2(totalVat - receivedVat),
    };
  }

  /** Modelo 347 — clientes con operaciones > 3.005,06 €/año, desglose trimestral. */
  async model347(
    tenantId: string,
    year: number,
    ownerId: string | null = null,
  ): Promise<Model347Dto> {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31));
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            deletedAt: null,
            ownerId,
            status: { in: [...FISCAL_STATUSES] },
            kind: 'invoice', // los justificantes de fianza no son facturas
            issueDate: { gte: from, lte: to },
            customerId: { not: null },
          },
          select: {
            total: true,
            issueDate: true,
            correctionMethod: true,
            rectifiesInvoice: { select: { total: true } },
            customerNameSnapshot: true,
            customerTaxIdSnapshot: true,
            customer: {
              select: {
                id: true,
                customerType: true,
                firstName: true,
                lastName: true,
                companyName: true,
                documentNumber: true,
              },
            },
          },
          orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
        }),
      tenantId,
    );

    // Por NIF (el declarado es el tercero, no la ficha): dos fichas con el mismo
    // NIF suman juntas. El nombre, el de su última factura.
    const byNif = new Map<
      string,
      { name: string; nif: string; total: number; q: [number, number, number, number] }
    >();
    // Sin NIF no se puede declarar: se avisa de los que pasan del umbral.
    const noNif = new Map<string, { name: string; total: number }>();
    for (const inv of invoices) {
      const nif = snapshotNif(inv);
      if (!nif && inv.issueDate) {
        const key = inv.customer?.id ?? inv.customerNameSnapshot ?? '?';
        const prev = noNif.get(key) ?? {
          name: inv.customerNameSnapshot ?? customerName(inv.customer),
          total: 0,
        };
        prev.total +=
          Number(inv.total) -
          (inv.correctionMethod === 'by_substitution' && inv.rectifiesInvoice
            ? Number(inv.rectifiesInvoice.total)
            : 0);
        noNif.set(key, prev);
      }
      if (!nif || !inv.issueDate) continue; // 347 exige NIF
      const key = normalizeNif(nif);
      const q = Math.floor(inv.issueDate.getUTCMonth() / 3); // 0-3
      const entry = byNif.get(key) ?? {
        name: '',
        nif: key,
        total: 0,
        q: [0, 0, 0, 0] as [number, number, number, number],
      };
      entry.name = inv.customerNameSnapshot ?? customerName(inv.customer);
      const amount =
        Number(inv.total) -
        (inv.correctionMethod === 'by_substitution' && inv.rectifiesInvoice
          ? Number(inv.rectifiesInvoice.total)
          : 0);
      entry.total += amount;
      entry.q[q] = (entry.q[q] ?? 0) + amount;
      byNif.set(key, entry);
    }

    // Cobros en efectivo del año por NIF (se informan a partir de 6.000 €).
    const cashPayments = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where: {
            methodType: 'cash',
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: from, lt: new Date(Date.UTC(year + 1, 0, 1)) },
            invoice: { kind: 'invoice', ownerId, deletedAt: null },
          },
          select: {
            amount: true,
            refundedAmount: true,
            invoice: {
              select: {
                customerNameSnapshot: true,
                customerTaxIdSnapshot: true,
                customer: { select: { documentNumber: true } },
              },
            },
          },
        }),
      tenantId,
    );
    const cashByNif = new Map<string, number>();
    for (const p of cashPayments) {
      const nif = p.invoice ? snapshotNif(p.invoice) : null;
      if (!nif) continue;
      const key = normalizeNif(nif);
      cashByNif.set(key, (cashByNif.get(key) ?? 0) + Number(p.amount) - Number(p.refundedAmount));
    }

    const rows: Model347Row[] = [...byNif.values()]
      .filter((e) => e.total > MODEL_347_THRESHOLD)
      .map((e) => ({
        customerName: e.name,
        nif: e.nif,
        total: round2(e.total),
        q1: round2(e.q[0]),
        q2: round2(e.q[1]),
        q3: round2(e.q[2]),
        q4: round2(e.q[3]),
        cash: round2(cashByNif.get(e.nif) ?? 0),
      }))
      .sort((a, b) => b.total - a.total);

    // Proveedores: gastos del año (IVA incluido). Los que llevan retención se
    // declaran en el 190 o el 180, no en el 347.
    const expenses = await this.prisma.withTenant(
      (tx) =>
        tx.expense.findMany({
          where: {
            ...ownerExpenseWhere(ownerId),
            expenseDate: { gte: from, lte: to },
            withholdingAmount: null,
          },
          select: {
            expenseDate: true,
            amount: true,
            baseAmount: true,
            vatAmount: true,
            vendor: true,
            vendorTaxId: true,
            supplier: { select: { name: true } },
          },
          orderBy: { expenseDate: 'asc' },
        }),
      tenantId,
    );
    const bySupplier = new Map<
      string,
      { name: string; total: number; q: [number, number, number, number] }
    >();
    const noNifSuppliers = new Map<string, { name: string; total: number }>();
    for (const e of expenses) {
      const amount =
        e.baseAmount !== null ? Number(e.baseAmount) + Number(e.vatAmount ?? 0) : Number(e.amount);
      const name = e.supplier?.name ?? e.vendor ?? 'Proveedor';
      if (!e.vendorTaxId) {
        if (!e.vendor && !e.supplier) continue;
        const key = name.toLowerCase();
        const prev = noNifSuppliers.get(key) ?? { name, total: 0 };
        prev.total += amount;
        noNifSuppliers.set(key, prev);
        continue;
      }
      const key = normalizeNif(e.vendorTaxId);
      const entry = bySupplier.get(key) ?? {
        name,
        total: 0,
        q: [0, 0, 0, 0] as [number, number, number, number],
      };
      entry.name = name;
      entry.total += amount;
      const q = Math.floor(e.expenseDate.getUTCMonth() / 3);
      entry.q[q] = (entry.q[q] ?? 0) + amount;
      bySupplier.set(key, entry);
    }
    const suppliers: Model347SupplierRow[] = [...bySupplier.entries()]
      .filter(([, e]) => e.total > MODEL_347_THRESHOLD)
      .map(([nif, e]) => ({
        supplierName: e.name,
        nif,
        total: round2(e.total),
        q1: round2(e.q[0]),
        q2: round2(e.q[1]),
        q3: round2(e.q[2]),
        q4: round2(e.q[3]),
      }))
      .sort((a, b) => b.total - a.total);
    const withoutNif = [
      ...[...noNif.values()].map((e) => ({ ...e, kind: 'customer' as const })),
      ...[...noNifSuppliers.values()].map((e) => ({ ...e, kind: 'supplier' as const })),
    ]
      .filter((e) => e.total > MODEL_347_THRESHOLD)
      .map((e) => ({ ...e, total: round2(e.total) }))
      .sort((a, b) => b.total - a.total);

    return { year, threshold: MODEL_347_THRESHOLD, rows, suppliers, withoutNif };
  }

  /** Libro registro de facturas recibidas: los gastos desglosados del periodo. */
  async receivedBook(
    tenantId: string,
    from: string,
    to: string,
    ownerId: string | null = null,
  ): Promise<ReceivedInvoicesBookDto> {
    const { fromD, toD } = parseRange(from, to);
    const [rows, unbroken, custom] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.expense.findMany({
            where: {
              ...ownerExpenseWhere(ownerId),
              baseAmount: { not: null },
              expenseDate: { gte: fromD, lte: toD },
            },
            select: {
              id: true,
              expenseDate: true,
              vendor: true,
              vendorTaxId: true,
              invoiceNumber: true,
              description: true,
              category: true,
              baseAmount: true,
              vatRate: true,
              vatAmount: true,
              vatDeductible: true,
              withholdingAmount: true,
              withholdingModel: true,
              totalAmount: true,
              receiptKey: true,
              facility: { select: { name: true } },
              supplier: { select: { name: true } },
            },
            orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
          }),
          tx.expense.aggregate({
            where: {
              ...ownerExpenseWhere(ownerId),
              baseAmount: null,
              expenseDate: { gte: fromD, lte: toD },
            },
            _count: { _all: true },
            _sum: { amount: true },
          }),
          tx.expenseCategory.findMany({ select: { id: true, name: true } }),
        ]),
      tenantId,
    );
    const byRate = new Map<number, { rate: number; base: number; vat: number }>();
    const totals = { base: 0, vat: 0, deductibleVat: 0, withholding: 0, total: 0 };
    const out = rows.map((e) => {
      const base = Number(e.baseAmount ?? 0);
      const vat = Number(e.vatAmount ?? 0);
      const rate = Number(e.vatRate ?? 0);
      totals.base += base;
      totals.vat += vat;
      totals.withholding += Number(e.withholdingAmount ?? 0);
      totals.total += Number(e.totalAmount ?? base + vat);
      if (e.vatDeductible && rate > 0) {
        totals.deductibleVat += vat;
        const g = byRate.get(rate) ?? { rate, base: 0, vat: 0 };
        g.base += base;
        g.vat += vat;
        byRate.set(rate, g);
      }
      return {
        expenseId: e.id,
        date: e.expenseDate.toISOString().slice(0, 10),
        vendor: e.supplier?.name ?? e.vendor,
        vendorTaxId: e.vendorTaxId,
        invoiceNumber: e.invoiceNumber,
        description: e.description,
        categoryLabel: expenseCategoryLabel(e.category, custom),
        facilityName: e.facility?.name ?? null,
        base: round2(base),
        vatRate: rate,
        vat: round2(vat),
        deductible: e.vatDeductible,
        withholding: round2(Number(e.withholdingAmount ?? 0)),
        withholdingModel: (e.withholdingModel as '111' | '115' | null) ?? null,
        total: round2(Number(e.totalAmount ?? base + vat)),
        hasReceipt: !!e.receiptKey,
      };
    });
    return {
      from,
      to,
      rows: out,
      byRate: [...byRate.values()]
        .map((g) => ({ rate: g.rate, base: round2(g.base), vat: round2(g.vat) }))
        .sort((a, b) => b.rate - a.rate),
      totals: {
        base: round2(totals.base),
        vat: round2(totals.vat),
        deductibleVat: round2(totals.deductibleVat),
        withholding: round2(totals.withholding),
        total: round2(totals.total),
      },
      unbroken: {
        count: unbroken._count._all,
        amount: round2(Number(unbroken._sum.amount ?? 0)),
      },
    };
  }

  /**
   * Retenciones de un trimestre: las que practicas en los gastos (111
   * profesionales, 115 alquiler del local) y las que te practican tus
   * inquilinos empresa en sus facturas.
   */
  async withholdings(
    tenantId: string,
    year: number,
    quarter: number,
    ownerId: string | null = null,
  ): Promise<WithholdingsDto> {
    if (quarter < 1 || quarter > 4) {
      throw new BadRequestException({ code: 'invalid_quarter', message: 'Trimestre 1-4' });
    }
    const { from, to } = quarterRange(year, quarter);
    const [expenses, invoices] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.expense.findMany({
            where: {
              ...ownerExpenseWhere(ownerId),
              withholdingAmount: { gt: 0 },
              expenseDate: { gte: from, lte: to },
            },
            select: {
              baseAmount: true,
              withholdingAmount: true,
              withholdingModel: true,
              vendor: true,
              vendorTaxId: true,
              supplier: { select: { name: true } },
            },
          }),
          tx.invoice.findMany({
            where: {
              deletedAt: null,
              ownerId,
              kind: 'invoice',
              status: { in: [...FISCAL_STATUSES] },
              issueDate: { gte: from, lte: to },
              withholdingAmount: { gt: 0 },
            },
            select: { withholdingAmount: true, withholdingPct: true },
          }),
        ]),
      tenantId,
    );
    const models: WithholdingModelDto[] = (['111', '115'] as const).map((model) => {
      const list = expenses.filter((e) => (e.withholdingModel ?? '111') === model);
      const payees = new Map<
        string,
        { name: string; nif: string | null; base: number; amount: number }
      >();
      for (const e of list) {
        const nif = e.vendorTaxId ? normalizeNif(e.vendorTaxId) : null;
        const name = e.supplier?.name ?? e.vendor ?? 'Proveedor';
        const key = nif ?? name.toLowerCase();
        const p = payees.get(key) ?? { name, nif, base: 0, amount: 0 };
        p.base += Number(e.baseAmount ?? 0);
        p.amount += Number(e.withholdingAmount ?? 0);
        payees.set(key, p);
      }
      return {
        model,
        count: list.length,
        base: round2(list.reduce((s, e) => s + Number(e.baseAmount ?? 0), 0)),
        amount: round2(list.reduce((s, e) => s + Number(e.withholdingAmount ?? 0), 0)),
        payees: [...payees.values()]
          .map((p) => ({ ...p, base: round2(p.base), amount: round2(p.amount) }))
          .sort((a, b) => b.amount - a.amount),
      };
    });
    const receivedAmount = invoices.reduce((s, i) => s + Number(i.withholdingAmount ?? 0), 0);
    const receivedBase = invoices.reduce((s, i) => {
      const pct = Number(i.withholdingPct ?? 0);
      return s + (pct > 0 ? (Number(i.withholdingAmount ?? 0) * 100) / pct : 0);
    }, 0);
    return {
      year,
      quarter,
      models,
      received: {
        count: invoices.length,
        base: round2(receivedBase),
        amount: round2(receivedAmount),
      },
    };
  }

  /**
   * Exportación contable genérica (A3/Sage y similares): una fila por
   * (factura × tipo de IVA presente en ella), para que el asesor la importe
   * en su software y mapee las columnas la primera vez (plantilla
   * reutilizable después — ni A3 ni Sage exigen un layout fijo).
   */
  async accountingExport(
    tenantId: string,
    from: string,
    to: string,
    ownerId: string | null = null,
  ): Promise<AccountingExportDto> {
    const { fromD, toD } = parseRange(from, to);
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            deletedAt: null,
            ownerId,
            status: { in: [...FISCAL_STATUSES] },
            kind: 'invoice', // los justificantes de fianza no son facturas
            issueDate: { gte: fromD, lte: toD },
          },
          select: {
            invoiceNumber: true,
            issueDate: true,
            invoiceType: true,
            status: true,
            total: true,
            customerNameSnapshot: true,
            customerTaxIdSnapshot: true,
            customer: {
              select: {
                customerType: true,
                firstName: true,
                lastName: true,
                companyName: true,
                documentNumber: true,
              },
            },
            items: { select: { taxRate: true, taxCategory: true, taxAmount: true, total: true } },
            correctionMethod: true,
            rectifiesInvoice: {
              select: {
                subtotal: true,
                taxAmount: true,
                total: true,
                items: {
                  select: { taxRate: true, taxCategory: true, taxAmount: true, total: true },
                },
              },
            },
            // Sus rectificativas emitidas: dicen si está anulada o sustituida.
            rectifiedBy: {
              where: { deletedAt: null, status: { notIn: ['draft', 'cancelled'] } },
              select: { invoiceNumber: true, correctionMethod: true },
            },
          },
          orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
        }),
      tenantId,
    );

    const rows: AccountingExportRow[] = [];
    for (const inv of invoices) {
      const byRate = netByRate(inv);
      const issueDate = inv.issueDate ? ddmmyyyy(inv.issueDate) : null;
      const name = inv.customerNameSnapshot ?? customerName(inv.customer);
      const nif = snapshotNif(inv);
      const sub = substituted(inv);
      const invoiceTotal = round2(Number(inv.total) - (sub ? Number(sub.total) : 0));
      for (const v of sortedGroups(byRate.values())) {
        rows.push({
          invoiceNumber: inv.invoiceNumber,
          issueDate,
          invoiceType: inv.invoiceType,
          customerName: name,
          customerNif: nif,
          taxRate: v.rate,
          taxCategory: v.taxCategory,
          base: v.base,
          vat: v.vat,
          lineTotal: round2(v.base + v.vat),
          invoiceTotal,
          status:
            inv.status === 'rectified'
              ? rectifiedStatusLabel(inv.rectifiedBy)
              : (STATUS_LABELS[inv.status] ?? inv.status),
        });
      }
    }

    return { from, to, rows };
  }
}
