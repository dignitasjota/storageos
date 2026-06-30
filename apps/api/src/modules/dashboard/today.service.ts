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

  async getToday(tenantId: string): Promise<TodayDto> {
    const now = new Date();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const contractsLimit = new Date(now.getTime() + SOON_DAYS * 86_400_000);
    const reservationsLimit = new Date(now.getTime() + RESERVATION_SOON_DAYS * 86_400_000);

    return this.prisma.withTenant(async (tx) => {
      const [
        tasks,
        tasksCount,
        contracts,
        contractsCount,
        reservations,
        reservationsCount,
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
          },
          orderBy: [{ dueDate: 'asc' }],
          take: TAKE,
          select: { id: true, title: true, dueDate: true, priority: true },
        }),
        tx.task.count({
          where: {
            status: { in: ['open', 'in_progress'] },
            dueDate: { not: null, lte: endOfToday },
          },
        }),
        tx.contract.findMany({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: { not: null, gte: now, lte: contractsLimit },
          },
          orderBy: [{ endDate: 'asc' }],
          take: TAKE,
          include: {
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true } },
          },
        }),
        tx.contract.count({
          where: {
            status: { in: ['active', 'ending'] },
            endDate: { not: null, gte: now, lte: contractsLimit },
          },
        }),
        tx.reservation.findMany({
          where: { status: 'pending', validUntil: { gte: now, lte: reservationsLimit } },
          orderBy: [{ validUntil: 'asc' }],
          take: TAKE,
          include: {
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true } },
          },
        }),
        tx.reservation.count({
          where: { status: 'pending', validUntil: { gte: now, lte: reservationsLimit } },
        }),
        tx.invoice.aggregate({
          where: { status: 'overdue' },
          _sum: { total: true, amountPaid: true },
        }),
        tx.invoice.count({ where: { status: 'overdue' } }),
        tx.incident.count({
          where: { status: { in: ['reported', 'investigating'] }, deletedAt: null },
        }),
        tx.unitChangeRequest.count({ where: { status: 'pending' } }),
        tx.customerMessage.count({ where: { senderType: 'customer', readAt: null } }),
      ]);

      const totalPending =
        Number(invoicesAgg._sum.total ?? 0) - Number(invoicesAgg._sum.amountPaid ?? 0);

      const taskItems: TodayItemDto[] = tasks.map((t) => ({
        id: t.id,
        label: t.title,
        detail: t.priority,
        date: t.dueDate ? t.dueDate.toISOString() : null,
      }));
      const contractItems: TodayItemDto[] = contracts.map((c) => ({
        id: c.id,
        label: customerName(c.customer),
        detail: c.unit?.code ?? null,
        date: c.endDate ? c.endDate.toISOString() : null,
      }));
      const reservationItems: TodayItemDto[] = reservations.map((r) => ({
        id: r.id,
        label: r.customer ? customerName(r.customer) : 'Reserva',
        detail: r.unit?.code ?? null,
        date: r.validUntil.toISOString(),
      }));

      return {
        tasksDue: { count: tasksCount, items: taskItems },
        contractsEndingSoon: { count: contractsCount, items: contractItems },
        reservationsExpiring: { count: reservationsCount, items: reservationItems },
        invoicesOverdue: { count: invoicesCount, totalPending: Math.max(0, totalPending) },
        incidentsOpen,
        unitChangesPending,
        unreadMessages,
      };
    }, tenantId);
  }
}
