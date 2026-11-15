import { BadRequestException, Injectable } from '@nestjs/common';
import { nextOccurrence, type RecurrenceSpec } from '@storageos/shared';

import { optionalFacilityWhere, resolveFacilityFilter } from '../../common/facility-scope';
import { formatEur } from '../../common/format';
import { CONFIRMED_START_WHERE } from '../../common/pre-opening';
import { nextPriceChange, pendingPriceChanges } from '../../common/price-changes';
import { tenantFeatures } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { CalendarEventDto, Permission } from '@storageos/shared';

/** Lo que cada persona ve en el calendario, según sus permisos de lectura. */
interface CalendarAccess {
  tasks: boolean;
  contracts: boolean;
  reservations: boolean;
  reminders: boolean;
}

/** `AAAA-MM-DD` y un día que existe (no el 31 de febrero). */
function isCalendarDate(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function calendarAccess(
  permissions: readonly Permission[] | null | undefined,
): CalendarAccess {
  const has = (p: Permission) => !permissions || permissions.includes(p);
  return {
    tasks: has('tasks:read'),
    contracts: has('contracts:read'),
    reservations: has('reservations:read'),
    reminders: has('reminders:read'),
  };
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  async getEvents(
    tenantId: string,
    fromStr: string,
    toStr: string,
    filters: {
      facilityId?: string;
      facilityScope?: string[] | null;
      permissions?: readonly Permission[] | null;
    } = {},
  ): Promise<CalendarEventDto[]> {
    if (!isCalendarDate(fromStr) || !isCalendarDate(toStr)) {
      throw new BadRequestException({ code: 'invalid_range', message: 'Rango de fechas inválido' });
    }
    const access = calendarAccess(filters.permissions);
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
    const remindersOn =
      access.reminders &&
      (await tenantFeatures(this.admin, tenantId)).includes('business_reminders');
    const none = Promise.resolve([]);

    return this.prisma.withTenant(async (tx) => {
      const reminders = remindersOn
        ? await tx.businessReminder.findMany({
            where: { status: 'active', dueDate: range, ...own },
            select: { id: true, title: true, dueDate: true, facility: { select: { name: true } } },
          })
        : [];
      const [tasks, maintenance, contracts, reservations, starting] = await Promise.all([
        access.tasks
          ? tx.task.findMany({
              where: {
                status: { in: ['open', 'in_progress'] },
                deletedAt: null,
                dueDate: range,
                ...own,
              },
              select: { id: true, title: true, dueDate: true },
            })
          : none,
        // Todas las repeticiones del rango salen de la próxima fecha de cada plan.
        access.tasks
          ? tx.maintenancePlan.findMany({
              where: {
                isActive: true,
                nextRunDate: { lte: to },
                ...own,
                OR: [{ facilityId: null }, { facility: { deletedAt: null } }],
              },
              select: {
                id: true,
                title: true,
                nextRunDate: true,
                freq: true,
                interval: true,
                weekdays: true,
                dayOfMonth: true,
              },
            })
          : none,
        tx.contract.findMany({
          where: {
            status: { in: ['active', 'ending'] },
            deletedAt: null,
            endDate: range,
            ...byUnit,
            ...(access.contracts ? {} : { id: '00000000-0000-0000-0000-000000000000' }),
          },
          select: {
            id: true,
            status: true,
            autoRenew: true,
            endDate: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true } },
          },
        }),
        tx.reservation.findMany({
          // Las confirmadas también retienen el trastero hasta su fecha.
          where: {
            status: { in: ['pending', 'confirmed'] },
            validUntil: range,
            ...byUnit,
            ...(access.reservations ? {} : { id: '00000000-0000-0000-0000-000000000000' }),
          },
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
            ...CONFIRMED_START_WHERE,
            ...byUnit,
            ...(access.contracts ? {} : { id: '00000000-0000-0000-0000-000000000000' }),
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
      for (const r of reminders) {
        events.push({
          id: r.id,
          type: 'business_reminder',
          date: r.dueDate.toISOString(),
          label: r.title,
          detail: r.facility?.name ?? null,
          href: `/reminders?reminder=${r.id}`,
        });
      }
      for (const m of maintenance) {
        const spec: RecurrenceSpec = {
          freq: m.freq as RecurrenceSpec['freq'],
          interval: m.interval,
          weekdays: m.weekdays,
          dayOfMonth: m.dayOfMonth,
        };
        let day = m.nextRunDate;
        for (let n = 0; n < 100 && day.getTime() <= to.getTime(); n++) {
          if (day.getTime() >= from.getTime()) {
            events.push({
              id: `${m.id}:${day.toISOString().slice(0, 10)}`,
              type: 'maintenance',
              date: day.toISOString(),
              label: m.title,
              detail: null,
              href: '/maintenance',
            });
          }
          day = nextOccurrence(spec, day);
        }
      }
      for (const c of contracts) {
        if (!c.endDate) continue;
        // Con renovación automática y sin baja pedida no termina: se prorroga.
        const renews = c.autoRenew && c.status === 'active';
        events.push({
          id: c.id,
          type: renews ? 'contract_renewing' : 'contract_ending',
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
      // Cambios de cuota programados y subidas de una tanda.
      const priceChanges = access.contracts
        ? await pendingPriceChanges(tx, tenantId, { from, until: to })
        : new Map();
      if (priceChanges.size > 0) {
        const withChanges = await tx.contract.findMany({
          where: { id: { in: [...priceChanges.keys()] }, ...byUnit },
          select: {
            id: true,
            priceMonthly: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            unit: { select: { code: true } },
          },
        });
        for (const c of withChanges) {
          const next = nextPriceChange(Number(c.priceMonthly), priceChanges.get(c.id) ?? []);
          if (!next) continue;
          events.push({
            id: `price-${c.id}`,
            type: 'price_change',
            date: next.date.toISOString(),
            label: customerName(c.customer),
            detail: `${c.unit?.code ?? ''} · cuota ${formatEur(Number(c.priceMonthly))} → ${formatEur(next.price)}`,
            href: `/contracts/${c.id}`,
          });
        }
      }
      return events;
    }, tenantId);
  }
}
