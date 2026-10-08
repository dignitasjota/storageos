import { BadRequestException, Injectable } from '@nestjs/common';
import { MODEL_347_THRESHOLD } from '@storageos/shared';

import { PrismaService } from '../database/prisma.service';

import type {
  AccountingExportDto,
  AccountingExportRow,
  InvoiceTaxCategory,
  Model303Dto,
  Model347Dto,
  Model347Row,
  VatBookDto,
} from '@storageos/shared';

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

const STATUS_LABELS: Record<string, string> = {
  issued: 'Pendiente',
  paid: 'Pagada',
  overdue: 'Vencida',
  refunded: 'Reembolsada',
  partially_refunded: 'Reembolsada (parcial)',
  rectified: 'Anulada (con rectificativa)',
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

function quarterRange(year: number, quarter: number): { from: Date; to: Date } {
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
        customerName: customerName(inv.customer),
        customerNif: inv.customer?.documentNumber ?? null,
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

    return {
      year,
      quarter,
      byRate,
      totalBase: round2(byRate.reduce((s, r) => s + r.base, 0)),
      totalVat: round2(byRate.reduce((s, r) => s + r.vat, 0)),
      invoiceCount,
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
        }),
      tenantId,
    );

    const byCustomer = new Map<
      string,
      { name: string; nif: string; total: number; q: [number, number, number, number] }
    >();
    for (const inv of invoices) {
      const c = inv.customer;
      if (!c?.documentNumber || !inv.issueDate) continue; // 347 exige NIF
      const q = Math.floor(inv.issueDate.getUTCMonth() / 3); // 0-3
      const entry = byCustomer.get(c.id) ?? {
        name: customerName(c),
        nif: c.documentNumber,
        total: 0,
        q: [0, 0, 0, 0] as [number, number, number, number],
      };
      const amount =
        Number(inv.total) -
        (inv.correctionMethod === 'by_substitution' && inv.rectifiesInvoice
          ? Number(inv.rectifiesInvoice.total)
          : 0);
      entry.total += amount;
      entry.q[q] = (entry.q[q] ?? 0) + amount;
      byCustomer.set(c.id, entry);
    }

    const rows: Model347Row[] = [...byCustomer.values()]
      .filter((e) => e.total > MODEL_347_THRESHOLD)
      .map((e) => ({
        customerName: e.name,
        nif: e.nif,
        total: round2(e.total),
        q1: round2(e.q[0]),
        q2: round2(e.q[1]),
        q3: round2(e.q[2]),
        q4: round2(e.q[3]),
      }))
      .sort((a, b) => b.total - a.total);

    return { year, threshold: MODEL_347_THRESHOLD, rows };
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

    const rows: AccountingExportRow[] = [];
    for (const inv of invoices) {
      const byRate = netByRate(inv);
      const issueDate = inv.issueDate ? ddmmyyyy(inv.issueDate) : null;
      const name = customerName(inv.customer);
      const nif = inv.customer?.documentNumber ?? null;
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
          status: STATUS_LABELS[inv.status] ?? inv.status,
        });
      }
    }

    return { from, to, rows };
  }
}
