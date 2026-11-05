import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { resolveFacilityFilter } from '../../common/facility-scope';
import { noLiveReservationWhere } from '../../common/unit-holds';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  ReservationStatsDto,
  UnitInboxDto,
  UnitInboxItemDto,
  UnitInboxKind,
} from '@storageos/shared';

const DAY_MS = 86_400_000;
/** Las reservas que caducan en estos días entran en la bandeja. */
const RESERVATION_WINDOW_DAYS = 7;

const CUSTOMER = {
  select: { customerType: true, firstName: true, lastName: true, companyName: true },
} as const;
const ASSIGNEE = { select: { fullName: true } } as const;

function name(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Todo lo que espera respuesta sobre trasteros, en un solo sitio. */
@Injectable()
export class UnitInboxService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    args: {
      facilityId?: string;
      facilityScope?: string[] | null;
      /** Cambios y solicitudes piden además ver contratos. */
      includeRequests: boolean;
    },
  ): Promise<UnitInboxDto> {
    const ids = resolveFacilityFilter(args.facilityScope, args.facilityId);
    const counts: Record<UnitInboxKind, number> = {
      change: 0,
      request: 0,
      waitlist: 0,
      reservation: 0,
    };
    if (ids === null) return { items: [], counts };
    const now = Date.now();
    const age = (d: Date) => Math.max(0, Math.floor((now - d.getTime()) / DAY_MS));
    const inFacility = ids ? { in: ids } : undefined;

    const items = await this.prisma.withTenant(async (tx) => {
      const out: UnitInboxItemDto[] = [];
      if (args.includeRequests) {
        const changes = await tx.unitChangeRequest.findMany({
          where: {
            tenantId,
            status: 'pending',
            ...(inFacility
              ? {
                  OR: [
                    { contract: { unit: { facilityId: inFacility } } },
                    ...(args.facilityId ? [] : [{ contractId: null }]),
                  ],
                }
              : {}),
          },
          include: {
            customer: CUSTOMER,
            assignedTo: ASSIGNEE,
            targetUnit: { select: { code: true } },
            contract: {
              select: { unit: { select: { code: true, facility: { select: { name: true } } } } },
            },
          },
          take: 200,
        });
        for (const r of changes) {
          out.push({
            kind: 'change',
            id: r.id,
            title: name(r.customer),
            detail: r.targetUnit
              ? `Quiere el ${r.targetUnit.code}${r.contract ? ` (tiene el ${r.contract.unit.code})` : ''}`
              : r.note || null,
            facilityName: r.contract?.unit.facility.name ?? null,
            since: r.createdAt.toISOString(),
            ageDays: age(r.createdAt),
            dueAt: null,
            assignedToUserId: r.assignedToUserId,
            assignedToName: r.assignedTo?.fullName ?? null,
            link: '/unit-change-requests',
          });
        }
        const requests = await tx.unitRequest.findMany({
          where: {
            tenantId,
            status: 'pending',
            ...(inFacility
              ? args.facilityId
                ? { facilityId: inFacility }
                : { OR: [{ facilityId: inFacility }, { facilityId: null }] }
              : {}),
          },
          include: {
            customer: CUSTOMER,
            assignedTo: ASSIGNEE,
            facility: { select: { name: true } },
            unitType: { select: { name: true } },
            unit: { select: { code: true } },
          },
          take: 200,
        });
        for (const r of requests) {
          out.push({
            kind: 'request',
            id: r.id,
            title: name(r.customer),
            detail: r.unit?.code ?? r.unitType?.name ?? (r.note || null),
            facilityName: r.facility?.name ?? null,
            since: r.createdAt.toISOString(),
            ageDays: age(r.createdAt),
            dueAt: null,
            assignedToUserId: r.assignedToUserId,
            assignedToName: r.assignedTo?.fullName ?? null,
            link: '/unit-requests',
          });
        }
      }

      const [entries, free] = await Promise.all([
        tx.waitlistEntry.findMany({
          where: { status: 'waiting', ...(inFacility ? { facilityId: inFacility } : {}) },
          orderBy: { queueDate: 'asc' },
          take: 300,
          include: {
            assignedTo: ASSIGNEE,
            facility: { select: { name: true } },
            unitType: { select: { name: true } },
          },
        }),
        tx.unit.groupBy({
          by: ['facilityId', 'unitTypeId'],
          where: {
            status: 'available',
            ...noLiveReservationWhere(),
            ...(inFacility ? { facilityId: inFacility } : {}),
          },
          _count: { _all: true },
        }),
      ]);
      const left = new Map(free.map((f) => [`${f.facilityId}:${f.unitTypeId}`, f._count._all]));
      for (const e of entries) {
        const key = `${e.facilityId}:${e.unitTypeId}`;
        const n = left.get(key) ?? 0;
        if (n <= 0) continue;
        left.set(key, n - 1);
        out.push({
          kind: 'waitlist',
          id: e.id,
          title: e.contactName,
          detail: e.unitType.name,
          facilityName: e.facility.name,
          since: e.queueDate.toISOString(),
          ageDays: age(e.queueDate),
          dueAt: null,
          assignedToUserId: e.assignedToUserId,
          assignedToName: e.assignedTo?.fullName ?? null,
          link: '/waitlist',
        });
      }

      const reservations = await tx.reservation.findMany({
        where: {
          status: 'confirmed',
          validUntil: { gt: new Date(now), lte: new Date(now + RESERVATION_WINDOW_DAYS * DAY_MS) },
          ...(inFacility ? { unit: { facilityId: inFacility } } : {}),
        },
        take: 200,
        include: {
          customer: CUSTOMER,
          assignedTo: ASSIGNEE,
          unit: { select: { code: true, facility: { select: { name: true } } } },
        },
      });
      for (const r of reservations) {
        out.push({
          kind: 'reservation',
          id: r.id,
          title: r.customer ? name(r.customer) : 'Sin inquilino',
          detail: `Trastero ${r.unit.code}`,
          facilityName: r.unit.facility.name,
          since: r.createdAt.toISOString(),
          ageDays: age(r.createdAt),
          dueAt: r.validUntil.toISOString(),
          assignedToUserId: r.assignedToUserId,
          assignedToName: r.assignedTo?.fullName ?? null,
          link: '/reservations',
        });
      }
      return out;
    }, tenantId);

    for (const i of items) counts[i.kind] += 1;
    // Primero lo que lleva más tiempo esperando.
    items.sort((a, b) => b.ageDays - a.ageDays || a.since.localeCompare(b.since));
    return { items, counts };
  }

  async assign(
    tenantId: string,
    kind: UnitInboxKind,
    id: string,
    userId: string | null,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      if (userId) {
        const user = await tx.user.findFirst({
          where: { id: userId, isActive: true },
          select: { id: true },
        });
        if (!user) {
          throw new BadRequestException({ code: 'user_not_found', message: 'Usuario no válido' });
        }
      }
      const data = { assignedToUserId: userId };
      const where = { id, tenantId };
      const { count } =
        kind === 'change'
          ? await tx.unitChangeRequest.updateMany({ where, data })
          : kind === 'request'
            ? await tx.unitRequest.updateMany({ where, data })
            : kind === 'waitlist'
              ? await tx.waitlistEntry.updateMany({ where, data })
              : await tx.reservation.updateMany({ where, data });
      if (count === 0) {
        throw new NotFoundException({ code: 'not_found', message: 'No encontrado' });
      }
    }, tenantId);
  }

  /** Reservas y tiempos de respuesta del periodo. */
  async stats(
    tenantId: string,
    args: { days: number; facilityId?: string; facilityScope?: string[] | null },
  ): Promise<ReservationStatsDto> {
    const empty: ReservationStatsDto = {
      days: args.days,
      created: 0,
      converted: 0,
      expired: 0,
      cancelled: 0,
      conversionPct: null,
      signalsPaid: 0,
      requestResponseHours: null,
      requestsAnswered: 0,
    };
    const ids = resolveFacilityFilter(args.facilityScope, args.facilityId);
    if (ids === null) return empty;
    const since = new Date(Date.now() - args.days * DAY_MS);
    const unit: Prisma.ReservationWhereInput = ids ? { unit: { facilityId: { in: ids } } } : {};
    return this.prisma.withTenant(async (tx) => {
      const [byStatus, signalsPaid, changes, requests] = await Promise.all([
        tx.reservation.groupBy({
          by: ['status'],
          where: { createdAt: { gte: since }, ...unit },
          _count: { _all: true },
        }),
        tx.reservation.count({
          where: { depositPaid: true, createdAt: { gte: since }, ...unit },
        }),
        tx.unitChangeRequest.findMany({
          where: {
            tenantId,
            handledAt: { gte: since },
            handledByUserId: { not: null },
            ...(ids ? { contract: { unit: { facilityId: { in: ids } } } } : {}),
          },
          select: { createdAt: true, handledAt: true },
        }),
        tx.unitRequest.findMany({
          where: {
            tenantId,
            handledAt: { gte: since },
            handledByUserId: { not: null },
            ...(ids ? { facilityId: { in: ids } } : {}),
          },
          select: { createdAt: true, handledAt: true },
        }),
      ]);
      const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
      const converted = count('converted');
      const expired = count('expired');
      const cancelled = count('cancelled');
      const closed = converted + expired + cancelled;
      const hours = [...changes, ...requests].map(
        (r) => (r.handledAt!.getTime() - r.createdAt.getTime()) / 3_600_000,
      );
      const mid = median(hours);
      return {
        days: args.days,
        created: byStatus.reduce((s, b) => s + b._count._all, 0),
        converted,
        expired,
        cancelled,
        conversionPct: closed ? Math.round((converted / closed) * 100) : null,
        signalsPaid,
        requestResponseHours: mid === null ? null : Math.round(mid * 10) / 10,
        requestsAnswered: hours.length,
      };
    }, tenantId);
  }
}
