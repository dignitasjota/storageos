import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type {
  AvailableUnitDto,
  PortalUnitRequestInput,
  PortalUnitRequestDto,
  ResolveUnitRequestInput,
  UnitRequestDto,
  UnitRequestStatus,
} from '@storageos/shared';

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

const num = (d: { toString(): string } | null): number | null => (d == null ? null : Number(d));

@Injectable()
export class UnitRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---- portal ----

  /**
   * Trasteros `available` de los locales donde el inquilino tiene un contrato
   * activo/en baja. Le damos transparencia para que solicite uno adicional.
   */
  async availableForCustomer(tenantId: string, customerId: string): Promise<AvailableUnitDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: { tenantId, customerId, status: { in: ['active', 'ending'] }, deletedAt: null },
        select: { unit: { select: { facilityId: true } } },
      });
      const facilityIds = [...new Set(contracts.map((c) => c.unit.facilityId))];
      if (facilityIds.length === 0) return [];
      const units = await tx.unit.findMany({
        where: { tenantId, facilityId: { in: facilityIds }, status: 'available' },
        orderBy: [{ facilityId: 'asc' }, { code: 'asc' }],
        include: {
          facility: { select: { name: true } },
          unitType: { select: { id: true, name: true } },
        },
      });
      return units.map((u) => ({
        id: u.id,
        code: u.code,
        facilityId: u.facilityId,
        facilityName: u.facility.name,
        unitTypeId: u.unitType?.id ?? null,
        unitTypeName: u.unitType?.name ?? null,
        areaM2: num(u.areaM2),
        priceMonthly: num(u.basePriceMonthly),
      }));
    }, tenantId);
  }

  async createFromPortal(args: {
    tenantId: string;
    customerId: string;
    input: PortalUnitRequestInput;
  }): Promise<PortalUnitRequestDto> {
    const { tenantId, customerId, input } = args;
    // Si indica un trastero concreto, validamos que existe y está disponible.
    if (input.unitId) {
      const unitId = input.unitId;
      const unit = await this.prisma.withTenant(
        (tx) => tx.unit.findFirst({ where: { id: unitId, tenantId }, select: { status: true } }),
        tenantId,
      );
      if (!unit) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
    }
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.unitRequest.create({
          data: {
            tenantId,
            customerId,
            facilityId: input.facilityId ?? null,
            unitTypeId: input.unitTypeId ?? null,
            unitId: input.unitId ?? null,
            note: input.note ?? '',
            status: 'pending',
          },
          include: this.portalInclude(),
        }),
      tenantId,
    );
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: customerId, tenantId },
          select: { customerType: true, firstName: true, lastName: true, companyName: true },
        }),
      tenantId,
    );
    await this.notifications.create(tenantId, {
      type: 'unit_request.created',
      title: `Trastero adicional solicitado — ${customerName(customer)}`,
      body: (input.note ?? created.unit?.code ?? created.unitType?.name ?? '').slice(0, 140),
      link: '/unit-requests',
    });
    return this.toPortalDto(created);
  }

  async listForCustomer(tenantId: string, customerId: string): Promise<PortalUnitRequestDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitRequest.findMany({
          where: { tenantId, customerId },
          orderBy: { createdAt: 'desc' },
          include: this.portalInclude(),
        }),
      tenantId,
    );
    return rows.map((r) => this.toPortalDto(r));
  }

  // ---- staff ----

  async countPending(tenantId: string): Promise<number> {
    return this.prisma.withTenant(
      (tx) => tx.unitRequest.count({ where: { tenantId, status: 'pending' } }),
      tenantId,
    );
  }

  async list(tenantId: string, status?: string): Promise<UnitRequestDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.unitRequest.findMany({
          where: { tenantId, ...(status ? { status } : {}) },
          orderBy: { createdAt: 'desc' },
          include: this.staffInclude(),
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async resolve(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: ResolveUnitRequestInput;
  }): Promise<UnitRequestDto> {
    const { tenantId, userId, id, input } = args;
    const existing = await this.prisma.withTenant(
      (tx) => tx.unitRequest.findFirst({ where: { id, tenantId }, select: { status: true } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'request_not_found',
        message: 'Solicitud no encontrada',
      });
    }
    if (existing.status !== 'pending') {
      throw new BadRequestException({
        code: 'already_resolved',
        message: 'La solicitud ya está resuelta',
      });
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.unitRequest.update({
          where: { id },
          data: {
            status: input.status,
            resolutionNote: input.resolutionNote ?? null,
            handledByUserId: userId,
            handledAt: new Date(),
          },
          include: this.staffInclude(),
        }),
      tenantId,
    );
    return this.toDto(updated);
  }

  // ---- includes + mappers ----

  private portalInclude() {
    return {
      facility: { select: { name: true } },
      unitType: { select: { name: true } },
      unit: { select: { code: true } },
    } as const;
  }

  private staffInclude() {
    return {
      customer: {
        select: { customerType: true, firstName: true, lastName: true, companyName: true },
      },
      facility: { select: { name: true } },
      unitType: { select: { name: true } },
      unit: { select: { code: true } },
    } as const;
  }

  private toPortalDto(r: {
    id: string;
    note: string;
    status: string;
    createdAt: Date;
    resolutionNote: string | null;
    facility: { name: string } | null;
    unitType: { name: string } | null;
    unit: { code: string } | null;
  }): PortalUnitRequestDto {
    return {
      id: r.id,
      facilityName: r.facility?.name ?? null,
      unitTypeName: r.unitType?.name ?? null,
      unitCode: r.unit?.code ?? null,
      note: r.note,
      status: r.status as UnitRequestStatus,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private toDto(r: {
    id: string;
    customerId: string;
    facilityId: string | null;
    unitTypeId: string | null;
    unitId: string | null;
    note: string;
    status: string;
    resolutionNote: string | null;
    createdAt: Date;
    handledAt: Date | null;
    customer: {
      customerType: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    facility: { name: string } | null;
    unitType: { name: string } | null;
    unit: { code: string } | null;
  }): UnitRequestDto {
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: customerName(r.customer),
      facilityId: r.facilityId,
      facilityName: r.facility?.name ?? null,
      unitTypeId: r.unitTypeId,
      unitTypeName: r.unitType?.name ?? null,
      unitId: r.unitId,
      unitCode: r.unit?.code ?? null,
      note: r.note,
      status: r.status as UnitRequestStatus,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt.toISOString(),
      handledAt: r.handledAt?.toISOString() ?? null,
    };
  }
}
