import { Injectable } from '@nestjs/common';
import { leadSourceLabel, NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import {
  invoiceFacilityWhere,
  optionalFacilityWhere,
  resolveFacilityFilter,
} from '../../common/facility-scope';
import { formatEur, todayInTimezone, zonedDayStart } from '../../common/format';
import { resolveAnalyticsScope } from '../analytics/analytics-scope';
import {
  collectedBetween,
  contractMoves,
  invoicedBetween,
  receivables,
  tenantTimezone,
  unitCounts,
} from '../analytics/business-metrics';
import { PrismaService } from '../database/prisma.service';

import { overdueInvoiceWhere } from './today-filters';

import type { Prisma } from '@storageos/database';
import type {
  Permission,
  TodayActivityDto,
  TodayKpisDto,
  TodaySummaryDto,
} from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;
const ACTIVITY_HOURS = 48;

const SEVERITY_LABELS: Record<string, string> = {
  low: 'Gravedad baja',
  medium: 'Gravedad media',
  high: 'Gravedad alta',
  critical: 'Gravedad crítica',
};

/** Permiso de lectura que hace falta para ver cada tipo de actividad. */
const ACTIVITY_PERMISSION: Record<TodayActivityDto['kind'], Permission> = {
  contract_signed: 'contracts:read',
  payment_received: 'payments:read',
  payment_failed: 'payments:read',
  move_out_requested: 'contracts:read',
  lead_created: 'leads:read',
  customer_message: 'customers:read',
  incident_reported: 'incidents:read',
};

type NameRow = {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  customerType: string;
} | null;
const nameOf = (c: NameRow) =>
  !c
    ? 'Sin identificar'
    : c.customerType === 'business'
      ? (c.companyName ?? '—')
      : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
const NAME = { firstName: true, lastName: true, companyName: true, customerType: true } as const;

/**
 * Cabecera de «Hoy»: cifras del mes (lo cobrado frente a lo facturado, deuda,
 * ocupación, altas y bajas) y lo que ha pasado en las últimas 48 horas.
 */
@Injectable()
export class TodaySummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    tenantId: string,
    facilityId: string | undefined,
    scope: string[] | null,
    permissions: readonly Permission[],
    now = new Date(),
  ): Promise<TodaySummaryDto> {
    const [kpis, activity] = await Promise.all([
      this.kpis(tenantId, facilityId, scope, permissions, now),
      this.activity(tenantId, facilityId, scope, permissions, now),
    ]);
    return { kpis, activity };
  }

  /** Cifras del mes: las mismas en «Hoy» y en el Resumen. */
  async kpis(
    tenantId: string,
    facilityId: string | undefined,
    scope: string[] | null,
    permissions: readonly Permission[],
    now = new Date(),
  ): Promise<TodayKpisDto> {
    const metricsScope = resolveAnalyticsScope(scope, facilityId);
    const invWhere = (invoiceFacilityWhere(scope, facilityId) ?? {
      id: { in: [] },
    }) as Prisma.InvoiceWhereInput;

    return this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      const startOfToday = todayInTimezone(timezone, now);
      const today = startOfToday.toISOString().slice(0, 10);
      const monthStartDay = `${today.slice(0, 7)}-01`;
      const [y, m] = today.split('-').map(Number) as [number, number];
      const nextMonthDay = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      const monthFrom = zonedDayStart(monthStartDay, timezone);
      const monthTo = zonedDayStart(nextMonthDay, timezone);
      // Mes anterior hasta el mismo día (el 10 de mayo se compara con el 1-10 de
      // abril), para que la comparación sea justa a mitad de mes.
      const day = Number(today.slice(8, 10));
      const prevStartDay = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      const prevLastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
      const prevEndDay = new Date(Date.UTC(y, m - 2, Math.min(day, prevLastDay) + 1))
        .toISOString()
        .slice(0, 10);
      const prevFrom = zonedDayStart(prevStartDay, timezone);
      const prevTo = zonedDayStart(prevEndDay, timezone);

      const [
        invoiced,
        collected,
        debt,
        units,
        moves,
        debtorsWithoutPortal,
        prevInvoiced,
        prevCollected,
        prevMoves,
        tenantRow,
      ] = await Promise.all([
        invoicedBetween(tx, metricsScope, new Date(monthStartDay), new Date(nextMonthDay)),
        collectedBetween(tx, metricsScope, monthFrom, monthTo),
        receivables(tx, metricsScope, startOfToday),
        unitCounts(tx, metricsScope),
        contractMoves(tx, metricsScope, monthFrom, monthTo),
        // Deben algo y nunca han entrado en su área de clientes.
        tx.customer.count({
          where: {
            deletedAt: null,
            portalLastSeenAt: null,
            invoices: { some: { AND: [overdueInvoiceWhere(startOfToday), invWhere] } },
          },
        }),
        invoicedBetween(tx, metricsScope, new Date(prevStartDay), new Date(prevEndDay)),
        collectedBetween(tx, metricsScope, prevFrom, prevTo),
        contractMoves(tx, metricsScope, prevFrom, prevTo),
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { pricingTargetOccupancy: true },
        }),
      ]);

      const target = tenantRow?.pricingTargetOccupancy ?? 88;
      // Sin permiso sobre las facturas o los cobros no se enseña dinero.
      const moneyVisible =
        permissions.includes('invoices:read') && permissions.includes('payments:read');
      const money = (value: number) => (moneyVisible ? round2(value) : 0);

      return {
        moneyVisible,
        invoicedMonth: money(invoiced),
        collectedMonth: money(collected),
        overduePending: money(debt.overdue),
        occupancyPct: units.total ? Math.round((units.occupied / units.total) * 1000) / 10 : 0,
        freeUnits: units.available,
        totalUnits: units.total,
        moveInsMonth: moves.moveIns,
        moveOutsMonth: moves.moveOuts,
        debtorsWithoutPortal: moneyVisible ? debtorsWithoutPortal : 0,
        previous: {
          invoicedMonth: money(prevInvoiced),
          collectedMonth: money(prevCollected),
          moveInsMonth: prevMoves.moveIns,
          moveOutsMonth: prevMoves.moveOuts,
        },
        targetOccupancyPct: target,
        unitsToTarget: Math.max(0, Math.ceil((target * units.total) / 100) - units.occupied),
      };
    }, tenantId);
  }

  /** Lo que ha pasado en las últimas 48 horas. */
  private async activity(
    tenantId: string,
    facilityId: string | undefined,
    scope: string[] | null,
    permissions: readonly Permission[],
    now: Date,
  ): Promise<TodayActivityDto[]> {
    const ids = resolveFacilityFilter(scope, facilityId);
    const fac = ids === null ? { in: [] as string[] } : ids ? { in: ids } : undefined;
    const contractUnit: Prisma.ContractWhereInput = fac ? { unit: { facilityId: fac } } : {};
    const invWhere = (invoiceFacilityWhere(scope, facilityId) ?? {
      id: { in: [] },
    }) as Prisma.InvoiceWhereInput;
    const own = (optionalFacilityWhere(scope, facilityId) ?? {
      facilityId: { in: [] },
    }) as Prisma.IncidentWhereInput;
    const since = new Date(now.getTime() - ACTIVITY_HOURS * 3_600_000);

    return this.prisma.withTenant(async (tx) => {
      const [signed, paid, failed, movingOut, leads, messages, incidents] = await Promise.all([
        tx.contract.findMany({
          where: { ...contractUnit, deletedAt: null, signedAt: { gte: since } },
          select: {
            id: true,
            signedAt: true,
            unit: { select: { code: true } },
            customer: { select: NAME },
          },
          orderBy: { signedAt: 'desc' },
          take: 20,
        }),
        tx.payment.findMany({
          where: {
            invoice: invWhere,
            status: { in: ['succeeded', 'partially_refunded'] },
            paidAt: { gte: since },
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          select: {
            amount: true,
            paidAt: true,
            methodType: true,
            invoice: { select: { id: true, invoiceNumber: true } },
            customer: { select: NAME },
          },
          orderBy: { paidAt: 'desc' },
          take: 20,
        }),
        tx.payment.findMany({
          where: {
            invoice: invWhere,
            status: 'failed',
            returnedAt: null,
            createdAt: { gte: since },
          },
          select: {
            amount: true,
            createdAt: true,
            failureReason: true,
            invoice: { select: { id: true, invoiceNumber: true } },
            customer: { select: NAME },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        tx.contract.findMany({
          where: { ...contractUnit, deletedAt: null, endingRequestedAt: { gte: since } },
          select: {
            id: true,
            endingRequestedAt: true,
            endDate: true,
            unit: { select: { code: true } },
            customer: { select: NAME },
          },
          take: 20,
        }),
        tx.lead.findMany({
          where: { deletedAt: null, createdAt: { gte: since } },
          select: {
            id: true,
            createdAt: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            source: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        tx.customerMessage.findMany({
          where: { senderType: 'customer', createdAt: { gte: since } },
          select: { createdAt: true, body: true, customerId: true, customer: { select: NAME } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        tx.incident.findMany({
          where: { ...own, createdAt: { gte: since } },
          select: { id: true, createdAt: true, title: true, severity: true },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

      const activity: TodayActivityDto[] = [
        ...signed.map((c) => ({
          at: c.signedAt!.toISOString(),
          kind: 'contract_signed' as const,
          label: `${nameOf(c.customer)} firmó el contrato`,
          detail: c.unit.code,
          href: `/contracts/${c.id}`,
        })),
        ...paid.map((p) => ({
          at: p.paidAt!.toISOString(),
          kind: 'payment_received' as const,
          label: `Cobro de ${formatEur(Number(p.amount))} — ${nameOf(p.customer)}`,
          detail: p.invoice?.invoiceNumber ?? null,
          href: p.invoice ? `/invoices/${p.invoice.id}` : '/payments',
        })),
        ...failed.map((p) => ({
          at: p.createdAt.toISOString(),
          kind: 'payment_failed' as const,
          label: `Cobro rechazado de ${formatEur(Number(p.amount))} — ${nameOf(p.customer)}`,
          detail: p.failureReason ?? p.invoice?.invoiceNumber ?? null,
          href: p.invoice ? `/invoices/${p.invoice.id}` : '/payments',
        })),
        ...movingOut.map((c) => ({
          at: c.endingRequestedAt!.toISOString(),
          kind: 'move_out_requested' as const,
          label: `${nameOf(c.customer)} pidió la baja`,
          detail: `${c.unit.code}${c.endDate ? ` · hasta el ${c.endDate.toISOString().slice(0, 10).split('-').reverse().join('/')}` : ''}`,
          href: `/contracts/${c.id}`,
        })),
        ...leads.map((l) => ({
          at: l.createdAt.toISOString(),
          kind: 'lead_created' as const,
          label: `Contacto nuevo: ${[l.firstName, l.lastName].filter(Boolean).join(' ') || l.companyName || l.email || 'sin nombre'}`,
          detail: leadSourceLabel(l.source),
          href: '/leads',
        })),
        ...messages.map((m) => ({
          at: m.createdAt.toISOString(),
          kind: 'customer_message' as const,
          label: `Mensaje de ${nameOf(m.customer)}`,
          detail: m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body,
          href: `/customers/${m.customerId}`,
        })),
        ...incidents.map((i) => ({
          at: i.createdAt.toISOString(),
          kind: 'incident_reported' as const,
          label: `Incidencia: ${i.title}`,
          detail: SEVERITY_LABELS[i.severity] ?? i.severity,
          href: '/incidents',
        })),
      ]
        .filter((a) => permissions.includes(ACTIVITY_PERMISSION[a.kind]))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 40);

      return activity;
    }, tenantId);
  }
}
