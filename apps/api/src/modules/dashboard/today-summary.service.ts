import { Injectable } from '@nestjs/common';
import { NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import {
  invoiceFacilityWhere,
  optionalFacilityWhere,
  resolveFacilityFilter,
} from '../../common/facility-scope';
import { formatEur, todayInTimezone, zonedDayStart } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { TodayActivityDto, TodaySummaryDto } from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;
const ACTIVITY_HOURS = 48;

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
    now = new Date(),
  ): Promise<TodaySummaryDto> {
    const ids = resolveFacilityFilter(scope, facilityId);
    const fac = ids === null ? { in: [] as string[] } : ids ? { in: ids } : undefined;
    const unitWhere: Prisma.UnitWhereInput = fac ? { facilityId: fac } : {};
    const contractUnit: Prisma.ContractWhereInput = fac ? { unit: { facilityId: fac } } : {};
    const invWhere = (invoiceFacilityWhere(scope, facilityId) ?? {
      id: { in: [] },
    }) as Prisma.InvoiceWhereInput;
    const own = (optionalFacilityWhere(scope, facilityId) ?? {
      facilityId: { in: [] },
    }) as Prisma.IncidentWhereInput;

    const today = todayInTimezone('Europe/Madrid', now).toISOString().slice(0, 10);
    const monthStartDay = `${today.slice(0, 7)}-01`;
    const [y, m] = today.split('-').map(Number) as [number, number];
    const nextMonthDay = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const monthFrom = zonedDayStart(monthStartDay);
    const monthTo = zonedDayStart(nextMonthDay);
    const since = new Date(now.getTime() - ACTIVITY_HOURS * 3_600_000);
    // Mes anterior hasta el mismo día (el 10 de mayo se compara con el 1-10 de
    // abril), para que la comparación sea justa a mitad de mes.
    const day = Number(today.slice(8, 10));
    const prevStartDay = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const prevLastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
    const prevEndDay = new Date(Date.UTC(y, m - 2, Math.min(day, prevLastDay) + 1))
      .toISOString()
      .slice(0, 10);
    const prevFrom = zonedDayStart(prevStartDay);
    const prevTo = zonedDayStart(prevEndDay);

    return this.prisma.withTenant(async (tx) => {
      const [
        invoiced,
        collected,
        overdue,
        unitsByStatus,
        moveIns,
        moveOuts,
        signed,
        paid,
        failed,
        movingOut,
        leads,
        messages,
        incidents,
        debtorsWithoutPortal,
        prevInvoiced,
        prevCollected,
        prevMoveIns,
        prevMoveOuts,
        tenantRow,
      ] = await Promise.all([
        tx.invoice.aggregate({
          where: {
            ...invWhere,
            deletedAt: null,
            kind: 'invoice',
            status: { notIn: ['draft', 'cancelled', 'rectified'] },
            issueDate: { gte: new Date(monthStartDay), lt: new Date(nextMonthDay) },
          },
          _sum: { total: true },
        }),
        tx.payment.aggregate({
          where: {
            invoice: invWhere,
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: monthFrom, lt: monthTo },
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          _sum: { amount: true },
        }),
        tx.invoice.aggregate({
          where: { ...invWhere, deletedAt: null, kind: 'invoice', status: 'overdue' },
          _sum: { total: true, amountPaid: true },
        }),
        tx.unit.groupBy({ by: ['status'], where: unitWhere, _count: { _all: true } }),
        tx.contract.count({
          where: { ...contractUnit, deletedAt: null, signedAt: { gte: monthFrom, lt: monthTo } },
        }),
        tx.contract.count({
          where: {
            ...contractUnit,
            deletedAt: null,
            status: 'ended',
            endDate: { gte: new Date(monthStartDay), lt: new Date(nextMonthDay) },
          },
        }),
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
        // Deben algo y nunca han entrado en su área de clientes.
        tx.customer.count({
          where: {
            deletedAt: null,
            portalLastSeenAt: null,
            invoices: { some: { ...invWhere, deletedAt: null, status: 'overdue' } },
          },
        }),
        tx.invoice.aggregate({
          where: {
            ...invWhere,
            deletedAt: null,
            kind: 'invoice',
            status: { notIn: ['draft', 'cancelled', 'rectified'] },
            issueDate: { gte: new Date(prevStartDay), lt: new Date(prevEndDay) },
          },
          _sum: { total: true },
        }),
        tx.payment.aggregate({
          where: {
            invoice: invWhere,
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            paidAt: { gte: prevFrom, lt: prevTo },
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          _sum: { amount: true },
        }),
        tx.contract.count({
          where: { ...contractUnit, deletedAt: null, signedAt: { gte: prevFrom, lt: prevTo } },
        }),
        tx.contract.count({
          where: {
            ...contractUnit,
            deletedAt: null,
            status: 'ended',
            endDate: { gte: new Date(prevStartDay), lt: new Date(prevEndDay) },
          },
        }),
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { pricingTargetOccupancy: true },
        }),
      ]);

      const count = (s: string) => unitsByStatus.find((u) => u.status === s)?._count._all ?? 0;
      const totalUnits = unitsByStatus.reduce((s, u) => s + u._count._all, 0);
      const occupied = count('occupied');
      const target = tenantRow?.pricingTargetOccupancy ?? 88;

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
          detail: l.source,
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
          detail: i.severity,
          href: '/incidents',
        })),
      ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 40);

      return {
        kpis: {
          invoicedMonth: round2(Number(invoiced._sum.total ?? 0)),
          collectedMonth: round2(Number(collected._sum.amount ?? 0)),
          overduePending: round2(
            Math.max(0, Number(overdue._sum.total ?? 0) - Number(overdue._sum.amountPaid ?? 0)),
          ),
          occupancyPct: totalUnits ? Math.round((occupied / totalUnits) * 1000) / 10 : 0,
          freeUnits: count('available'),
          totalUnits,
          moveInsMonth: moveIns,
          moveOutsMonth: moveOuts,
          debtorsWithoutPortal,
          previous: {
            invoicedMonth: round2(Number(prevInvoiced._sum.total ?? 0)),
            collectedMonth: round2(Number(prevCollected._sum.amount ?? 0)),
            moveInsMonth: prevMoveIns,
            moveOutsMonth: prevMoveOuts,
          },
          targetOccupancyPct: target,
          unitsToTarget: Math.max(0, Math.ceil((target * totalUnits) / 100) - occupied),
        },
        activity,
      };
    }, tenantId);
  }
}
