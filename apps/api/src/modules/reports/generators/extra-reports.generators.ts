import { Injectable } from '@nestjs/common';
import { leadSourceLabel } from '@storageos/shared';

import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../../common/format';
import { toCents } from '../../../common/money';
import {
  contractWhere,
  invoiceWhere,
  LIVE_CONTRACT_WHERE,
  leadWhere,
  MONTHLY_FEE_SELECT,
  monthlyFee,
  unitWhere,
} from '../../analytics/analytics-scope';
import {
  INVOICED_SELECT,
  invoicedAmount,
  invoicedBase,
  invoicedWhere,
} from '../../analytics/business-metrics';
import { PrismaService } from '../../database/prisma.service';

import {
  CONTRACT_STATUS_LABELS,
  CUSTOMER_NAME_SELECT,
  customerDisplay,
  dayLabel,
  dayRange,
  decimal,
  eur,
  zonedDayKey,
} from './report-helpers';

import type { ReportGenerator, ReportGeneratorContext, ReportResult } from './types';

const DAY = 86_400_000;
const FORMATS = ['pdf', 'xlsx'] as const as ('pdf' | 'xlsx')[];
const PERIOD = {
  from: { label: 'Desde', type: 'date' as const, required: true },
  to: { label: 'Hasta', type: 'date' as const, required: true },
};
const pct = (part: number, total: number) =>
  total > 0 ? `${decimal((part / total) * 100)} %` : '—';

/** A quién llamar: deuda por inquilino, lo más antiguo primero. */
@Injectable()
export class DebtorsByCustomerGenerator implements ReportGenerator {
  readonly code = 'debtors_by_customer';
  readonly name = 'Deudores por inquilino';
  readonly description =
    'Cada inquilino con facturas sin cobrar: cuánto debe, cuánto está vencido, desde cuándo, su teléfono y el último contacto.';
  readonly formats = FORMATS;
  readonly requires = ['invoices:read', 'customers:read'] as const as [
    'invoices:read',
    'customers:read',
  ];
  readonly byFacility = true;
  readonly paramsSchema = {};

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const today = todayInTimezone(ctx.timezone);
    const { invoices, contacts } = await this.prisma.withTenant(async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: {
          deletedAt: null,
          kind: 'invoice',
          customerId: { not: null },
          status: { in: ['issued', 'overdue'] },
          ...invoiceWhere(ctx.scope),
        },
        select: {
          customerId: true,
          total: true,
          amountPaid: true,
          dueDate: true,
          customer: { select: { ...CUSTOMER_NAME_SELECT, phone: true, email: true } },
        },
      });
      const ids = [...new Set(invoices.map((i) => i.customerId!))];
      const contacts = ids.length
        ? await tx.customerInteraction.groupBy({
            by: ['customerId'],
            where: { customerId: { in: ids } },
            _max: { occurredAt: true },
          })
        : [];
      return { invoices, contacts };
    }, ctx.tenantId);

    const lastContact = new Map(contacts.map((c) => [c.customerId, c._max.occurredAt]));
    const by = new Map<
      string,
      {
        name: string;
        phone: string;
        email: string;
        count: number;
        pending: number;
        overdue: number;
        oldest: Date | null;
      }
    >();
    for (const i of invoices) {
      const cents = toCents(i.total) - toCents(i.amountPaid);
      if (cents <= 0) continue;
      const cur = by.get(i.customerId!) ?? {
        name: customerDisplay(i.customer),
        phone: i.customer?.phone ?? '—',
        email: i.customer?.email ?? '—',
        count: 0,
        pending: 0,
        overdue: 0,
        oldest: null,
      };
      cur.count += 1;
      cur.pending += cents;
      if (i.dueDate && i.dueDate < today) {
        cur.overdue += cents;
        if (!cur.oldest || i.dueDate < cur.oldest) cur.oldest = i.dueDate;
      }
      by.set(i.customerId!, cur);
    }
    let pendingTotal = 0;
    let overdueTotal = 0;
    const rows = [...by.entries()]
      .sort((a, b) => b[1].overdue - a[1].overdue || b[1].pending - a[1].pending)
      .map(([id, v]) => {
        pendingTotal += v.pending;
        overdueTotal += v.overdue;
        const last = lastContact.get(id);
        return {
          customer: v.name,
          phone: v.phone,
          email: v.email,
          invoices: v.count,
          pending: v.pending / 100,
          overdue: v.overdue / 100,
          // Sin nada vencido, en blanco (no «0 días»).
          days: v.oldest ? Math.floor((today.getTime() - v.oldest.getTime()) / DAY) : null,
          lastContact: last ? dayLabel(zonedDayKey(last, ctx.timezone)) : 'Nunca',
        };
      });
    return {
      title: 'Deudores por inquilino',
      subtitle: `A ${dayLabel(today)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'customer', label: 'Inquilino', width: 28 },
        { key: 'phone', label: 'Teléfono', width: 14 },
        { key: 'email', label: 'Email', width: 26 },
        { key: 'invoices', label: 'Facturas', type: 'number', align: 'right' },
        { key: 'pending', label: 'Pendiente', type: 'currency', align: 'right' },
        { key: 'overdue', label: 'Vencido', type: 'currency', align: 'right' },
        { key: 'days', label: 'Días de retraso', type: 'number', align: 'right' },
        { key: 'lastContact', label: 'Último contacto', width: 14 },
      ],
      rows,
      summary: [
        { label: 'Inquilinos con deuda', value: String(rows.length) },
        { label: 'Pendiente de cobro', value: eur(pendingTotal / 100) },
        { label: 'Vencido', value: eur(overdueTotal / 100) },
      ],
    };
  }
}

/** Contratos que terminan pronto o con la baja pedida. */
@Injectable()
export class ContractsEndingGenerator implements ReportGenerator {
  readonly code = 'contracts_ending';
  readonly name = 'Vencimientos y bajas próximas';
  readonly description =
    'Los contratos que terminan en los próximos días o que ya han pedido la baja, con su cuota y si se renuevan solos.';
  readonly formats = FORMATS;
  readonly requires = ['contracts:read'] as const as ['contracts:read'];
  readonly byFacility = true;
  readonly paramsSchema = {
    days: {
      label: 'En los próximos',
      type: 'select' as const,
      required: true,
      options: [
        { value: '30', label: '30 días' },
        { value: '60', label: '60 días' },
        { value: '90', label: '90 días' },
      ],
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const days = [30, 60, 90].includes(Number(ctx.params.days)) ? Number(ctx.params.days) : 30;
    const today = todayInTimezone(ctx.timezone);
    const until = new Date(today.getTime() + days * DAY);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            ...LIVE_CONTRACT_WHERE,
            ...contractWhere(ctx.scope),
            OR: [{ status: 'ending' }, { endDate: { gte: today, lte: until } }],
          },
          select: {
            ...MONTHLY_FEE_SELECT,
            contractNumber: true,
            status: true,
            endDate: true,
            autoRenew: true,
            customer: { select: { ...CUSTOMER_NAME_SELECT, phone: true } },
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
          orderBy: { endDate: 'asc' },
        }),
      ctx.tenantId,
    );
    let feeCents = 0;
    let leaving = 0;
    const out = rows.map((c) => {
      const fee = Math.round(monthlyFee(c) * 100);
      // Lo que se deja de cobrar: las que se van, no las que se renuevan solas.
      const goes = c.status === 'ending' || !c.autoRenew;
      if (goes) {
        feeCents += fee;
        leaving += 1;
      }
      return {
        contract: c.contractNumber,
        customer: customerDisplay(c.customer),
        phone: c.customer?.phone ?? '—',
        facility: c.unit.facility.name,
        unit: c.unit.code,
        end: c.endDate ? c.endDate.toISOString().slice(0, 10) : '',
        status: CONTRACT_STATUS_LABELS[c.status] ?? c.status,
        renews: c.status === 'ending' ? 'No (baja pedida)' : c.autoRenew ? 'Sí' : 'No',
        fee: fee / 100,
      };
    });
    return {
      title: 'Vencimientos y bajas próximas',
      subtitle: `Del ${dayLabel(today)} al ${dayLabel(until)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'contract', label: 'Contrato', width: 16 },
        { key: 'customer', label: 'Inquilino', width: 26 },
        { key: 'phone', label: 'Teléfono', width: 14 },
        { key: 'facility', label: 'Local', width: 16 },
        { key: 'unit', label: 'Trastero', width: 10 },
        { key: 'end', label: 'Fin', type: 'date', width: 12 },
        { key: 'status', label: 'Estado', width: 12 },
        { key: 'renews', label: 'Se renueva', width: 14 },
        { key: 'fee', label: 'Cuota al mes', type: 'currency', align: 'right' },
      ],
      rows: out,
      summary: [
        { label: 'Contratos', value: String(out.length) },
        { label: 'Se van (baja pedida o sin renovación)', value: String(leaving) },
        { label: 'Cuotas que se dejarían de cobrar al mes', value: eur(feeCents / 100) },
      ],
    };
  }
}

/** Trasteros libres y cuánto llevan vacíos. */
@Injectable()
export class FreeUnitsGenerator implements ReportGenerator {
  readonly code = 'free_units';
  readonly name = 'Trasteros libres';
  readonly description =
    'Cada trastero libre con su tamaño, su precio y los días que lleva vacío, del que más al que menos.';
  readonly formats = FORMATS;
  readonly requires = ['units:read'] as const as ['units:read'];
  readonly byFacility = true;
  readonly paramsSchema = {};

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const today = todayInTimezone(ctx.timezone);
    const units = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findMany({
          where: { status: 'available', ...unitWhere(ctx.scope) },
          select: {
            code: true,
            areaM2: true,
            basePriceMonthly: true,
            createdAt: true,
            facility: { select: { name: true } },
            unitType: { select: { name: true } },
            statusHistory: {
              where: { newStatus: 'available' },
              orderBy: { occurredAt: 'desc' },
              take: 1,
              select: { occurredAt: true },
            },
          },
        }),
      ctx.tenantId,
    );
    let priceCents = 0;
    let daysSum = 0;
    const rows = units
      .map((u) => {
        const since = u.statusHistory[0]?.occurredAt ?? u.createdAt;
        const days = Math.max(0, Math.floor((Date.now() - since.getTime()) / DAY));
        return { u, since, days };
      })
      .sort((a, b) => b.days - a.days)
      .map(({ u, since, days }) => {
        priceCents += toCents(u.basePriceMonthly);
        daysSum += days;
        return {
          facility: u.facility.name,
          unit: u.code,
          type: u.unitType.name,
          m2: u.areaM2 == null ? null : Number(u.areaM2),
          price: Number(u.basePriceMonthly),
          since: dayLabel(zonedDayKey(since, ctx.timezone)),
          days,
        };
      });
    return {
      title: 'Trasteros libres',
      subtitle: `A ${dayLabel(today)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'facility', label: 'Local', width: 20 },
        { key: 'unit', label: 'Trastero', width: 12 },
        { key: 'type', label: 'Tipo', width: 18 },
        { key: 'm2', label: 'm²', type: 'number', align: 'right' },
        { key: 'price', label: 'Precio al mes', type: 'currency', align: 'right' },
        { key: 'since', label: 'Libre desde', width: 12 },
        { key: 'days', label: 'Días libre', type: 'number', align: 'right' },
      ],
      rows,
      summary: [
        { label: 'Trasteros libres', value: String(rows.length) },
        {
          label: 'Lo que dejan de ingresar al mes (precio de lista)',
          value: eur(priceCents / 100),
        },
        {
          label: 'Media de días libre',
          value: rows.length ? String(Math.round(daysSum / rows.length)) : '—',
        },
      ],
    };
  }
}

/** Fianzas que el negocio tiene retenidas (y las que aún no ha cobrado). */
@Injectable()
export class DepositsHeldGenerator implements ReportGenerator {
  readonly code = 'deposits_held';
  readonly name = 'Fianzas retenidas';
  readonly description =
    'Las fianzas de los contratos que aún no se han liquidado: importe, si está cobrada y el estado del contrato. Útil para saber cuánto hay que devolver.';
  readonly formats = FORMATS;
  readonly requires = ['contracts:read', 'payments:read'] as const as [
    'contracts:read',
    'payments:read',
  ];
  readonly byFacility = true;
  readonly paramsSchema = {};

  constructor(private readonly prisma: PrismaService) {}

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { contracts, paid } = await this.prisma.withTenant(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: {
          deletedAt: null,
          signedAt: { not: null },
          depositStatus: 'held',
          depositAmount: { gt: 0 },
          customer: { isTest: false },
          ...contractWhere(ctx.scope),
        },
        select: {
          id: true,
          contractNumber: true,
          status: true,
          depositAmount: true,
          endDate: true,
          customer: { select: CUSTOMER_NAME_SELECT },
          unit: { select: { code: true, facility: { select: { name: true } } } },
        },
        orderBy: { contractNumber: 'asc' },
      });
      // Cobrada: justificante de fianza pagado o línea «Fianza» en una factura pagada.
      const paid = contracts.length
        ? await tx.invoice.findMany({
            where: {
              contractId: { in: contracts.map((c) => c.id) },
              deletedAt: null,
              status: { in: ['paid', 'partially_refunded', 'refunded'] },
              OR: [
                { kind: 'deposit_receipt' },
                { items: { some: { description: { startsWith: 'Fianza' } } } },
              ],
            },
            select: { contractId: true },
          })
        : [];
      return { contracts, paid };
    }, ctx.tenantId);
    const collected = new Set(paid.map((p) => p.contractId));
    let heldCents = 0;
    let pendingCents = 0;
    const rows = contracts.map((c) => {
      const cents = toCents(c.depositAmount);
      const isPaid = collected.has(c.id);
      if (isPaid) heldCents += cents;
      else pendingCents += cents;
      return {
        contract: c.contractNumber,
        customer: customerDisplay(c.customer),
        facility: c.unit.facility.name,
        unit: c.unit.code,
        status: CONTRACT_STATUS_LABELS[c.status] ?? c.status,
        end: c.endDate ? c.endDate.toISOString().slice(0, 10) : '',
        deposit: cents / 100,
        collected: isPaid ? 'Sí' : 'Pendiente de cobro',
      };
    });
    return {
      title: 'Fianzas retenidas',
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'contract', label: 'Contrato', width: 16 },
        { key: 'customer', label: 'Inquilino', width: 26 },
        { key: 'facility', label: 'Local', width: 16 },
        { key: 'unit', label: 'Trastero', width: 10 },
        { key: 'status', label: 'Contrato', width: 12 },
        { key: 'end', label: 'Fin', type: 'date', width: 12 },
        { key: 'deposit', label: 'Fianza', type: 'currency', align: 'right' },
        { key: 'collected', label: 'Cobrada', width: 16 },
      ],
      rows,
      summary: [
        { label: 'Contratos con fianza', value: String(rows.length) },
        { label: 'Fianzas cobradas (a devolver al terminar)', value: eur(heldCents / 100) },
        { label: 'Fianzas aún sin cobrar', value: eur(pendingCents / 100) },
      ],
    };
  }
}

/** De qué tamaños sale lo facturado. */
@Injectable()
export class InvoicingByUnitTypeGenerator implements ReportGenerator {
  readonly code = 'invoicing_by_unit_type';
  readonly name = 'Facturación por tipo de trastero';
  readonly description =
    'Lo facturado entre dos fechas repartido por tipo de trastero (y lo que no es de ningún trastero: ventas, pases…), con su peso en el total.';
  readonly formats = FORMATS;
  readonly requires = ['invoices:read'] as const as ['invoices:read'];
  readonly byFacility = true;
  readonly paramsSchema = PERIOD;

  constructor(private readonly prisma: PrismaService) {}

  validate(params: Record<string, unknown>): void {
    dayRange(params);
  }

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { from, to } = dayRange(ctx.params);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          // El mismo «facturado» del Resumen: sin borradores ni fianzas.
          where: invoicedWhere(ctx.scope, from, new Date(to.getTime() + DAY)),
          select: {
            ...INVOICED_SELECT,
            contract: { select: { unit: { select: { unitType: { select: { name: true } } } } } },
          },
        }),
      ctx.tenantId,
    );
    const by = new Map<string, { count: number; base: number; total: number }>();
    let totalCents = 0;
    for (const r of rows) {
      const name = r.contract?.unit.unitType.name ?? 'Sin trastero (ventas, pases…)';
      const cur = by.get(name) ?? { count: 0, base: 0, total: 0 };
      const total = toCents(invoicedAmount(r));
      cur.count += 1;
      cur.base += toCents(invoicedBase(r));
      cur.total += total;
      totalCents += total;
      by.set(name, cur);
    }
    const out = [...by.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, v]) => ({
        type: name,
        invoices: v.count,
        base: v.base / 100,
        tax: (v.total - v.base) / 100,
        total: v.total / 100,
        share: pct(v.total, totalCents),
      }));
    return {
      title: 'Facturación por tipo de trastero',
      subtitle: `${dayLabel(from)} – ${dayLabel(to)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'type', label: 'Tipo de trastero', width: 26 },
        { key: 'invoices', label: 'Facturas', type: 'number', align: 'right' },
        { key: 'base', label: 'Base', type: 'currency', align: 'right' },
        { key: 'tax', label: 'IVA', type: 'currency', align: 'right' },
        { key: 'total', label: 'Total', type: 'currency', align: 'right' },
        { key: 'share', label: '% del total', align: 'right' },
      ],
      rows: out,
      summary: [{ label: 'Total facturado', value: eur(totalCents / 100) }],
    };
  }
}

/** De dónde llegan los contactos y cuántos acaban alquilando. */
@Injectable()
export class LeadsBySourceGenerator implements ReportGenerator {
  readonly code = 'leads_by_source';
  readonly name = 'Contactos por origen';
  readonly description =
    'Los contactos que llegaron entre dos fechas según su origen (web, Idealista, llamada…), cuántos se ganaron y la conversión de cada uno.';
  readonly formats = FORMATS;
  readonly requires = ['leads:read'] as const as ['leads:read'];
  readonly byFacility = true;
  readonly paramsSchema = PERIOD;

  constructor(private readonly prisma: PrismaService) {}

  validate(params: Record<string, unknown>): void {
    dayRange(params);
  }

  async run(ctx: ReportGeneratorContext): Promise<ReportResult> {
    const { fromKey, toKey } = dayRange(ctx.params);
    const groups = await this.prisma.withTenant(
      (tx) =>
        tx.lead.groupBy({
          by: ['source', 'status'],
          where: {
            deletedAt: null,
            createdAt: {
              gte: zonedDayStart(fromKey, ctx.timezone),
              lt: zonedNextDayStart(toKey, ctx.timezone),
            },
            ...leadWhere(ctx.scope),
          },
          _count: { _all: true },
        }),
      ctx.tenantId,
    );
    const by = new Map<string, { total: number; won: number; lost: number }>();
    for (const g of groups) {
      const label = leadSourceLabel(g.source);
      const cur = by.get(label) ?? { total: 0, won: 0, lost: 0 };
      cur.total += g._count._all;
      if (g.status === 'won') cur.won += g._count._all;
      if (g.status === 'lost') cur.lost += g._count._all;
      by.set(label, cur);
    }
    let total = 0;
    let won = 0;
    const rows = [...by.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([source, v]) => {
        total += v.total;
        won += v.won;
        return {
          source,
          total: v.total,
          won: v.won,
          lost: v.lost,
          open: v.total - v.won - v.lost,
          conversion: pct(v.won, v.total),
        };
      });
    return {
      title: 'Contactos por origen',
      subtitle: `${dayLabel(fromKey)} – ${dayLabel(toKey)}`,
      generatedAt: new Date(),
      timezone: ctx.timezone,
      columns: [
        { key: 'source', label: 'Origen', width: 24 },
        { key: 'total', label: 'Contactos', type: 'number', align: 'right' },
        { key: 'won', label: 'Ganados', type: 'number', align: 'right' },
        { key: 'lost', label: 'Perdidos', type: 'number', align: 'right' },
        { key: 'open', label: 'Abiertos', type: 'number', align: 'right' },
        { key: 'conversion', label: 'Conversión', align: 'right' },
      ],
      rows,
      summary: [
        { label: 'Contactos', value: String(total) },
        { label: 'Ganados', value: String(won) },
        { label: 'Conversión', value: pct(won, total) },
      ],
    };
  }
}

export const EXTRA_REPORT_GENERATORS = [
  DebtorsByCustomerGenerator,
  ContractsEndingGenerator,
  FreeUnitsGenerator,
  DepositsHeldGenerator,
  InvoicingByUnitTypeGenerator,
  LeadsBySourceGenerator,
];
