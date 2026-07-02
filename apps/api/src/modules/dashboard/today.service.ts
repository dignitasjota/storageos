import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { TodayDto, TodayItemDto } from '@storageos/shared';

const SOON_DAYS = 30; // contratos que vencen pronto
const RESERVATION_SOON_DAYS = 7;
const TAKE = 8;

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Bandeja operativa «Hoy»: agrega en una sola llamada lo que el equipo debe
 * atender hoy (tareas vencidas, contratos/reservas que vencen, incidencias,
 * facturas vencidas, cambios y mensajes pendientes). Todo con `withTenant` (RLS).
 */
@Injectable()
export class TodayService {
  constructor(private readonly prisma: PrismaService) {}

  async getToday(tenantId: string, facilityId?: string): Promise<TodayDto> {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const contractsLimit = new Date(now.getTime() + SOON_DAYS * 86_400_000);
    const reservationsLimit = new Date(now.getTime() + RESERVATION_SOON_DAYS * 86_400_000);
    const today = { gte: startOfToday, lte: endOfToday };
    const customerSelect = {
      select: { customerType: true, firstName: true, lastName: true, companyName: true },
    } as const;

    // Filtro por local: las secciones ancladas a un local (entradas/salidas,
    // firmas, contratos, reservas, facturas, tareas, incidencias) se acotan al
    // `facilityId` elegido; las de empresa (leads, seguimientos, mensajes,
    // cambios) se dejan a nivel tenant. `contract → unit.facilityId`,
    // `reservation → unit.facilityId`, `invoice → contract.unit.facilityId`,
    // y task/incident tienen `facilityId` propio.
    const facContract = facilityId ? { unit: { is: { facilityId } } } : {};
    const facTaskIncident = facilityId ? { facilityId } : {};
    const facInvoice = facilityId ? { contract: { is: { unit: { is: { facilityId } } } } } : {};

    return this.prisma.withTenant(async (tx) => {
      const [
        tasks,
        tasksCount,
        moveIns,
        moveInsCount,
        moveOuts,
        moveOutsCount,
        followups,
        followupsCount,
        leads,
        leadsCount,
        signatures,
        signaturesCount,
        contracts,
        contractsCount,
        reservations,
        reservationsCount,
        dueTodayAgg,
        dueTodayCount,
        invoicesAgg,
        invoicesCount,
        incidentsOpen,
        unitChangesPending,
        unreadMessages,
      ] = await Promise.all([
        tx.task.findMany({
          where: {
            status: { in: ['open', 'in_progress'] },
            dueDate: { not: null, lte: endOfToday },
            ...facTaskIncident,
          },
          orderBy: [{ dueDate: 'asc' }],
          take: TAKE,
          select: { id: true, title: true, dueDate: true, priority: true },
        }),
        tx.task.count({
          where: {
            status: { in: ['open', 'in_progress'] },
            dueDate: { not: null, lte: endOfToday },
            ...facTaskIncident,
          },
        }),
        // Entradas de hoy: contratos que empiezan hoy.
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, startDate: today, ...facContract },
          orderBy: [{ startDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: { status: { in: ['active', 'ending'] }, startDate: today, ...facContract },
        }),
        // Salidas de hoy: contratos que terminan hoy.
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, endDate: today, ...facContract },
          orderBy: [{ endDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: { status: { in: ['active', 'ending'] }, endDate: today, ...facContract },
        }),
        // Seguimientos CRM vencidos o para hoy.
        tx.customerFollowup.findMany({
          where: { status: 'pending', dueDate: { lte: endOfToday } },
          orderBy: [{ dueDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect },
        }),
        tx.customerFollowup.count({ where: { status: 'pending', dueDate: { lte: endOfToday } } }),
        // Leads nuevos sin contactar.
        tx.lead.findMany({
          where: { status: 'new', deletedAt: null },
          orderBy: [{ createdAt: 'desc' }],
          take: TAKE,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            source: true,
            createdAt: true,
          },
        }),
        tx.lead.count({ where: { status: 'new', deletedAt: null } }),
        // Firmas pendientes: token de firma vigente sin firmar.
        tx.contract.findMany({
          where: {
            signedAt: null,
            signingTokenHash: { not: null },
            signingTokenExpiresAt: { gte: now },
            ...facContract,
          },
          orderBy: [{ signingTokenExpiresAt: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: {
            signedAt: null,
            signingTokenHash: { not: null },
            signingTokenExpiresAt: { gte: now },
            ...facContract,
          },
        }),
        tx.contract.findMany({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: { not: null, gte: now, lte: contractsLimit },
            ...facContract,
          },
          orderBy: [{ endDate: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.contract.count({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: { not: null, gte: now, lte: contractsLimit },
            ...facContract,
          },
        }),
        tx.reservation.findMany({
          where: {
            status: 'pending',
            validUntil: { gte: now, lte: reservationsLimit },
            ...facContract,
          },
          orderBy: [{ validUntil: 'asc' }],
          take: TAKE,
          include: { customer: customerSelect, unit: { select: { code: true } } },
        }),
        tx.reservation.count({
          where: {
            status: 'pending',
            validUntil: { gte: now, lte: reservationsLimit },
            ...facContract,
          },
        }),
        // Facturas que vencen hoy.
        tx.invoice.aggregate({
          where: { status: 'issued', dueDate: today, ...facInvoice },
          _sum: { total: true, amountPaid: true },
        }),
        tx.invoice.count({ where: { status: 'issued', dueDate: today, ...facInvoice } }),
        tx.invoice.aggregate({
          where: { status: 'overdue', ...facInvoice },
          _sum: { total: true, amountPaid: true },
        }),
        tx.invoice.count({ where: { status: 'overdue', ...facInvoice } }),
        tx.incident.count({
          where: {
            status: { in: ['reported', 'investigating'] },
            deletedAt: null,
            ...facTaskIncident,
          },
        }),
        tx.unitChangeRequest.count({ where: { status: 'pending' } }),
        tx.customerMessage.count({ where: { senderType: 'customer', readAt: null } }),
      ]);

      const totalPending =
        Number(invoicesAgg._sum.total ?? 0) - Number(invoicesAgg._sum.amountPaid ?? 0);
      const totalDueToday =
        Number(dueTodayAgg._sum.total ?? 0) - Number(dueTodayAgg._sum.amountPaid ?? 0);

      const contractItem = (c: {
        id: string;
        endDate: Date | null;
        startDate?: Date;
        customer: Parameters<typeof customerName>[0];
        unit: { code: string } | null;
      }): TodayItemDto => ({
        id: c.id,
        label: customerName(c.customer),
        detail: c.unit?.code ?? null,
        date: (c.endDate ?? c.startDate ?? null)?.toISOString() ?? null,
      });

      const taskItems: TodayItemDto[] = tasks.map((t) => ({
        id: t.id,
        label: t.title,
        detail: t.priority,
        date: t.dueDate ? t.dueDate.toISOString() : null,
        overdue: t.dueDate ? t.dueDate < startOfToday : false,
      }));
      const followupItems: TodayItemDto[] = followups.map((f) => ({
        id: f.id,
        label: f.title,
        detail: customerName(f.customer),
        date: f.dueDate.toISOString(),
        overdue: f.dueDate < startOfToday,
        linkId: f.customerId,
      }));
      const leadItems: TodayItemDto[] = leads.map((l) => ({
        id: l.id,
        label: customerName({ ...l, customerType: l.companyName ? 'business' : 'individual' }),
        detail: l.source,
        date: l.createdAt.toISOString(),
      }));
      const signatureItems: TodayItemDto[] = signatures.map((c) => ({
        id: c.id,
        label: customerName(c.customer),
        detail: c.unit?.code ?? null,
        date: c.signingTokenExpiresAt ? c.signingTokenExpiresAt.toISOString() : null,
      }));

      const urgentCount =
        tasksCount + followupsCount + moveInsCount + moveOutsCount + dueTodayCount + invoicesCount;

      return {
        date: startOfToday.toISOString(),
        urgentCount,
        moveInsToday: {
          count: moveInsCount,
          items: moveIns.map((c) => contractItem({ ...c, startDate: c.startDate })),
        },
        moveOutsToday: { count: moveOutsCount, items: moveOuts.map((c) => contractItem(c)) },
        tasksDue: { count: tasksCount, items: taskItems },
        followupsDue: { count: followupsCount, items: followupItems },
        newLeads: { count: leadsCount, items: leadItems },
        signaturesPending: { count: signaturesCount, items: signatureItems },
        contractsEndingSoon: {
          count: contractsCount,
          items: contracts.map((c) => contractItem(c)),
        },
        reservationsExpiring: {
          count: reservationsCount,
          items: reservations.map((r) => ({
            id: r.id,
            label: r.customer ? customerName(r.customer) : 'Reserva',
            detail: r.unit?.code ?? null,
            date: r.validUntil.toISOString(),
          })),
        },
        invoicesDueToday: { count: dueTodayCount, totalDue: Math.max(0, totalDueToday) },
        invoicesOverdue: { count: invoicesCount, totalPending: Math.max(0, totalPending) },
        incidentsOpen,
        unitChangesPending,
        unreadMessages,
      };
    }, tenantId);
  }
}
