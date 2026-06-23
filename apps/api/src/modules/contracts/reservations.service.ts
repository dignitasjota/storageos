import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Reservation, ReservationStatus } from '@storageos/database';
import type {
  CancelReservationInput,
  ContractDto,
  ConvertReservationInput,
  CreateReservationInput,
  ReservationDto,
  ReservationStatusValue,
} from '@storageos/shared';

type ReservationWithRelations = Reservation & {
  unit: { code: string; facilityId: string; facility: { name: string } };
  customer: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: 'individual' | 'business';
  } | null;
};

interface ListFilters {
  unitId?: string;
  customerId?: string;
  status?: ReservationStatusValue;
  facilityId?: string;
  /** Permisos por local: si está, solo reservas de unidades de esos locales. */
  facilityScope?: string[] | null;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contracts: ContractsService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<ReservationDto[]> {
    const where: Prisma.ReservationWhereInput = {};
    if (filters.unitId) where.unitId = filters.unitId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.status) where.status = filters.status as ReservationStatus;
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return []; // local pedido fuera del scope del usuario
    if (facFilter) where.unit = { facilityId: { in: facFilter } };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.reservation.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          include: {
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
              },
            },
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<ReservationDto> {
    return this.toDto(await this.findOrThrow(tenantId, id, facilityScope));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateReservationInput;
    meta: RequestMeta;
  }): Promise<ReservationDto> {
    const validFrom = new Date(args.input.validFrom);
    const validUntil = new Date(args.input.validUntil);

    const created = await this.prisma.withTenant(async (tx) => {
      const unit = await tx.unit.findUnique({ where: { id: args.input.unitId } });
      if (!unit) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
      if (
        unit.status === 'occupied' ||
        unit.status === 'maintenance' ||
        unit.status === 'blocked'
      ) {
        throw new ConflictException({
          code: 'unit_not_reservable',
          message: `El trastero esta en estado ${unit.status}`,
        });
      }
      if (args.input.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: args.input.customerId, deletedAt: null },
        });
        if (!customer) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'Inquilino no encontrado',
          });
        }
      }
      try {
        return await tx.reservation.create({
          data: {
            tenantId: args.tenantId,
            unitId: args.input.unitId,
            ...(args.input.customerId ? { customerId: args.input.customerId } : {}),
            status: 'pending',
            validFrom,
            validUntil,
            depositAmount: args.input.depositAmount,
            notes: args.input.notes?.trim() || null,
          },
          include: {
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
              },
            },
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
          },
        });
      } catch (err) {
        if (this.isExcludeViolation(err)) {
          throw new ConflictException({
            code: 'reservation_overlap',
            message: 'Ya existe una reserva activa que solapa con este rango',
          });
        }
        throw err;
      }
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.created',
      entityType: 'Reservation',
      entityId: created.id,
      changes: {
        unitId: args.input.unitId,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async confirm(args: {
    tenantId: string;
    userId: string;
    reservationId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ReservationDto> {
    const existing = await this.findOrThrow(args.tenantId, args.reservationId, args.facilityScope);
    this.assertTransition(existing.status, 'confirmed');

    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.reservation.update({
        where: { id: args.reservationId },
        data: { status: 'confirmed' },
        include: {
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
        },
      });
      // Marcar la unit como reserved si estaba available.
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
      if (unit.status === 'available') {
        await tx.unit.update({
          where: { id: unit.id },
          data: { status: 'reserved' },
        });
        await tx.unitStatusHistory.create({
          data: {
            tenantId: args.tenantId,
            unitId: unit.id,
            previousStatus: 'available',
            newStatus: 'reserved',
            changedByUserId: args.userId,
            reason: `Reserva ${row.id} confirmada`,
          },
        });
      }
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.confirmed',
      entityType: 'Reservation',
      entityId: updated.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async cancel(args: {
    tenantId: string;
    userId: string;
    reservationId: string;
    facilityScope?: string[] | null;
    input: CancelReservationInput;
    meta: RequestMeta;
  }): Promise<ReservationDto> {
    const existing = await this.findOrThrow(args.tenantId, args.reservationId, args.facilityScope);
    this.assertTransition(existing.status, 'cancelled');
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.reservation.update({
        where: { id: args.reservationId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: args.input.reason?.trim() || null,
        },
        include: {
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
            },
          },
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
        },
      });
      // Si la unit estaba reserved por esta reserva (no hay otra activa),
      // devolverla a available.
      if (existing.status === 'confirmed') {
        const stillReserved = await tx.reservation.findFirst({
          where: {
            unitId: existing.unitId,
            status: { in: ['pending', 'confirmed'] },
            id: { not: existing.id },
          },
        });
        if (!stillReserved) {
          const unit = await tx.unit.findUniqueOrThrow({
            where: { id: existing.unitId },
          });
          if (unit.status === 'reserved') {
            await tx.unit.update({
              where: { id: unit.id },
              data: { status: 'available' },
            });
            await tx.unitStatusHistory.create({
              data: {
                tenantId: args.tenantId,
                unitId: unit.id,
                previousStatus: 'reserved',
                newStatus: 'available',
                changedByUserId: args.userId,
                reason: `Reserva ${row.id} cancelada`,
              },
            });
          }
        }
      }
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.cancelled',
      entityType: 'Reservation',
      entityId: updated.id,
      changes: { reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async convertToContract(args: {
    tenantId: string;
    userId: string;
    reservationId: string;
    facilityScope?: string[] | null;
    input: ConvertReservationInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.reservationId, args.facilityScope);
    if (existing.status !== 'pending' && existing.status !== 'confirmed') {
      throw new BadRequestException({
        code: 'reservation_not_convertible',
        message: 'Solo se pueden convertir reservas pending o confirmed',
      });
    }
    const customerId = args.input.customerId ?? existing.customerId;
    if (!customerId) {
      throw new BadRequestException({
        code: 'customer_required',
        message: 'La reserva no tiene customer; envia customerId',
      });
    }

    const contract = await this.prisma.withTenant(async (tx) => {
      const created = await this.contracts.createFromReservation(tx, {
        tenantId: args.tenantId,
        userId: args.userId,
        reservationId: args.reservationId,
        customerId,
        unitId: existing.unitId,
        startDate: args.input.startDate,
        ...(args.input.endDate ? { endDate: args.input.endDate } : {}),
        priceMonthly: args.input.priceMonthly,
        discountAmount: args.input.discountAmount,
        ...(args.input.discountReason ? { discountReason: args.input.discountReason } : {}),
        depositAmount: args.input.depositAmount,
        billingCycle: args.input.billingCycle,
      });
      await tx.reservation.update({
        where: { id: args.reservationId },
        data: { status: 'converted', convertedContractId: created.id },
      });
      return created;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.converted',
      entityType: 'Reservation',
      entityId: args.reservationId,
      changes: { contractId: contract.id, contractNumber: contract.contractNumber },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.contracts.detail(args.tenantId, contract.id);
  }

  /**
   * Marca reservas pending/confirmed cuyo `valid_until` ya paso como
   * `expired`. Llamado por un cron interno (Fase 4 con BullMQ) o por un
   * endpoint admin. Devuelve cuantas se han expirado.
   */
  async expireDue(tenantId: string): Promise<{ expired: number }> {
    const result = await this.prisma.withTenant(
      (tx) =>
        tx.reservation.updateMany({
          where: {
            status: { in: ['pending', 'confirmed'] },
            validUntil: { lt: new Date() },
          },
          data: { status: 'expired' },
        }),
      tenantId,
    );
    return { expired: result.count };
  }

  private async findOrThrow(
    tenantId: string,
    reservationId: string,
    facilityScope?: string[] | null,
  ): Promise<ReservationWithRelations> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.reservation.findUnique({
          where: { id: reservationId },
          include: {
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
              },
            },
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'reservation_not_found',
        message: 'Reserva no encontrada',
      });
    }
    assertFacilityAllowed(facilityScope, row.unit.facilityId);
    return row;
  }

  private assertTransition(from: ReservationStatus, to: ReservationStatusValue): void {
    const allowed: Record<ReservationStatusValue, ReservationStatusValue[]> = {
      pending: ['confirmed', 'cancelled', 'expired'],
      confirmed: ['cancelled', 'expired', 'converted'],
      expired: [],
      converted: [],
      cancelled: [],
    };
    if (!allowed[from as ReservationStatusValue].includes(to)) {
      throw new BadRequestException({
        code: 'invalid_reservation_transition',
        message: `Transicion invalida: ${from} -> ${to}`,
      });
    }
  }

  private isExcludeViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as {
      code?: string;
      message?: string;
      meta?: { constraint?: string; cause?: string };
    };
    const constraintName = typeof e.meta?.constraint === 'string' ? e.meta.constraint : '';
    const cause = typeof e.meta?.cause === 'string' ? e.meta.cause : '';
    const message = typeof e.message === 'string' ? e.message : '';
    // Postgres lanza SQLSTATE 23P01 (exclusion_violation). Prisma puede
    // mapearlo a varios codigos segun la version. Cubrimos los conocidos.
    if (e.code === 'P2010') return true;
    if (constraintName.includes('overlap') || constraintName.includes('no_overlap')) return true;
    if (cause.includes('23P01') || message.includes('23P01')) return true;
    if (message.includes('reservations_no_overlap_exclude')) return true;
    return false;
  }

  private toDto(row: ReservationWithRelations): ReservationDto {
    const customerName = row.customer
      ? row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre'
      : null;
    return {
      id: row.id,
      unitId: row.unitId,
      unitCode: row.unit.code,
      facilityId: row.unit.facilityId,
      facilityName: row.unit.facility.name,
      customerId: row.customerId,
      customerName,
      status: row.status as ReservationStatusValue,
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil.toISOString(),
      depositPaid: row.depositPaid,
      depositAmount: Number(row.depositAmount),
      notes: row.notes,
      convertedContractId: row.convertedContractId,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      cancelReason: row.cancelReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
