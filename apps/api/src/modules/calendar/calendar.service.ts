import { BadRequestException, Injectable } from '@nestjs/common';

import { optionalFacilityWhere, resolveFacilityFilter } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';

import type { CalendarEventDto } from '@storageos/shared';

const MAX_RANGE_DAYS = 92; // ~3 meses

function customerName(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return 'Cliente';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/**
 * Calendario operativo: agrega los vencimientos y eventos programados en un
 * rango (tareas, mantenimientos, fin de contrato, fin de reserva). `withTenant`.
 */
@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async getEvents(
    tenantId: string,
    fromStr: string,
    toStr: string,
    filters: { facilityId?: string; facilityScope?: string[] | null } = {},
  ): Promise<CalendarEventDto[]> {
    // Local elegido / locales del usuario: tareas y mantenimiento sin local son
    // de toda la empresa; contratos y reservas, del local de su trastero.
    const own = optionalFacilityWhere(filters.facilityScope, filters.facilityId);
    const ids = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (!own || ids === null) return [];
    const byUnit = ids ? { unit: { facilityId: { in: ids } } } : {};
    const from = new Date(fromStr);
    const to = new Date(toStr);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException({ code: 'invalid_range', message: 'Rango de fechas inválido' });
    }
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new BadRequestException({ code: 'range_too_wide', message: 'Rango demasiado amplio' });
    }
    const range = { gte: from, lte: to };

    return this.prisma.withTenant(async (tx) => {
      const [tasks, maintenance, contracts, reservations, starting] = await Promise.all([
        tx.task.findMany({
          where: { status: { in: ['open', 'in_progress'] }, dueDate: range, ...own },
          select: { id: true, title: true, dueDate: true },
        }),
        tx.maintenancePlan.findMany({
          where: { isActive: true, nextRunDate: range, ...own },
          select: { id: true, title: true, nextRunDate: true },
        }),
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, endDate: range, ...byUnit },
          select: {
            id: true,
            endDate: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true } },
          },
        }),
        tx.reservation.findMany({
          // Las confirmadas también retienen el trastero hasta su fecha.
          where: { status: { in: ['pending', 'confirmed'] }, validUntil: range, ...byUnit },
          select: {
            id: true,
            validUntil: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true } },
          },
        }),
        // Entradas: contratos (firmados o por firmar) que empiezan en el rango.
        tx.contract.findMany({
          where: {
            status: { in: ['draft', 'active'] },
            deletedAt: null,
            startDate: range,
            ...byUnit,
          },
          select: {
            id: true,
            startDate: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true } },
          },
        }),
      ]);

      const events: CalendarEventDto[] = [];
      for (const c of starting) {
        events.push({
          id: `start-${c.id}`,
          type: 'contract_starting',
          date: c.startDate.toISOString(),
          label: customerName(c.customer),
          detail: c.unit?.code ?? null,
          href: `/contracts/${c.id}`,
        });
      }
      for (const t of tasks) {
        if (!t.dueDate) continue;
        events.push({
          id: t.id,
          type: 'task',
          date: t.dueDate.toISOString(),
          label: t.title,
          detail: null,
          href: `/tasks?task=${t.id}`,
        });
      }
      for (const m of maintenance) {
        events.push({
          id: m.id,
          type: 'maintenance',
          date: m.nextRunDate.toISOString(),
          label: m.title,
          detail: null,
          href: '/maintenance',
        });
      }
      for (const c of contracts) {
        if (!c.endDate) continue;
        events.push({
          id: c.id,
          type: 'contract_ending',
          date: c.endDate.toISOString(),
          label: customerName(c.customer),
          detail: c.unit?.code ?? null,
          href: `/contracts/${c.id}`,
        });
      }
      for (const r of reservations) {
        events.push({
          id: r.id,
          type: 'reservation_expiring',
          date: r.validUntil.toISOString(),
          label: customerName(r.customer),
          detail: r.unit?.code ?? null,
          href: '/reservations',
        });
      }
      return events;
    }, tenantId);
  }
}
