import { BadRequestException, Injectable } from '@nestjs/common';
import { MODEL_347_THRESHOLD } from '@storageos/shared';

import { PrismaService } from '../database/prisma.service';

import type { Model303Dto, Model347Dto, Model347Row, VatBookDto } from '@storageos/shared';

/** Estados que cuentan a efectos fiscales (devengo): todo salvo borrador/anulada. */
const FISCAL_STATUSES = ['issued', 'paid', 'overdue', 'refunded', 'partially_refunded'] as const;

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
  async vatBook(tenantId: string, from: string, to: string): Promise<VatBookDto> {
    const fromD = new Date(`${from}T00:00:00Z`);
    const toD = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD > toD) {
      throw new BadRequestException({
        code: 'invalid_range',
        message: 'Rango de fechas no válido',
      });
    }
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            deletedAt: null,
            status: { in: [...FISCAL_STATUSES] },
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
            items: { select: { taxRate: true, taxAmount: true, total: true } },
          },
          orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
        }),
      tenantId,
    );

    const byRateMap = new Map<number, { base: number; vat: number }>();
    let totalBase = 0;
    let totalVat = 0;
    let totalTotal = 0;

    const rows = invoices.map((inv) => {
      const base = Number(inv.subtotal);
      const vat = Number(inv.taxAmount);
      totalBase += base;
      totalVat += vat;
      totalTotal += Number(inv.total);
      for (const item of inv.items) {
        const rate = Number(item.taxRate);
        const lineBase = Number(item.total) - Number(item.taxAmount);
        const prev = byRateMap.get(rate) ?? { base: 0, vat: 0 };
        byRateMap.set(rate, { base: prev.base + lineBase, vat: prev.vat + Number(item.taxAmount) });
      }
      return {
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDate ? inv.issueDate.toISOString().slice(0, 10) : null,
        invoiceType: inv.invoiceType,
        customerName: customerName(inv.customer),
        customerNif: inv.customer?.documentNumber ?? null,
        base: round2(base),
        vat: round2(vat),
        total: round2(Number(inv.total)),
      };
    });

    const byRate = [...byRateMap.entries()]
      .map(([rate, v]) => ({ rate, base: round2(v.base), vat: round2(v.vat) }))
      .sort((a, b) => b.rate - a.rate);

    return {
      from,
      to,
      rows,
      byRate,
      totals: { base: round2(totalBase), vat: round2(totalVat), total: round2(totalTotal) },
    };
  }

  /** Modelo 303 — IVA devengado (repercutido) por tipo, de un trimestre. */
  async model303(tenantId: string, year: number, quarter: number): Promise<Model303Dto> {
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
              status: { in: [...FISCAL_STATUSES] },
              issueDate: { gte: from, lte: to },
            },
          },
          select: { taxRate: true, taxAmount: true, total: true },
        }),
      tenantId,
    );
    const byRateMap = new Map<number, { base: number; vat: number }>();
    for (const item of items) {
      const rate = Number(item.taxRate);
      const lineBase = Number(item.total) - Number(item.taxAmount);
      const prev = byRateMap.get(rate) ?? { base: 0, vat: 0 };
      byRateMap.set(rate, { base: prev.base + lineBase, vat: prev.vat + Number(item.taxAmount) });
    }
    const byRate = [...byRateMap.entries()]
      .map(([rate, v]) => ({ rate, base: round2(v.base), vat: round2(v.vat) }))
      .sort((a, b) => b.rate - a.rate);

    const invoiceCount = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.count({
          where: {
            tenantId,
            deletedAt: null,
            status: { in: [...FISCAL_STATUSES] },
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
  async model347(tenantId: string, year: number): Promise<Model347Dto> {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31));
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            deletedAt: null,
            status: { in: [...FISCAL_STATUSES] },
            issueDate: { gte: from, lte: to },
            customerId: { not: null },
          },
          select: {
            total: true,
            issueDate: true,
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
      const amount = Number(inv.total);
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
}
