import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Facility, Prisma } from '@storageos/database';
import type { CreateFacilityInput, FacilityDto, UpdateFacilityInput } from '@storageos/shared';

type FacilityWithStats = Facility & {
  _count?: { units: number };
  units?: Array<{ status: string }>;
};

interface CreateArgs {
  tenantId: string;
  userId: string;
  input: CreateFacilityInput;
  meta: RequestMeta;
}

interface UpdateArgs {
  tenantId: string;
  userId: string;
  facilityId: string;
  input: UpdateFacilityInput;
  meta: RequestMeta;
}

interface DeleteArgs {
  tenantId: string;
  userId: string;
  facilityId: string;
  meta: RequestMeta;
}

@Injectable()
export class FacilitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<FacilityDto[]> {
    const facilities = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findMany({
          where: { deletedAt: null },
          orderBy: [{ name: 'asc' }],
          include: {
            units: {
              select: { status: true },
            },
          },
        }),
      tenantId,
    );
    return facilities.map((f) => this.toDto(f));
  }

  async detail(tenantId: string, facilityId: string): Promise<FacilityDto> {
    const facility = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({
          where: { id: facilityId, deletedAt: null },
          include: { units: { select: { status: true } } },
        }),
      tenantId,
    );
    if (!facility) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
    return this.toDto(facility);
  }

  async create(args: CreateArgs): Promise<FacilityDto> {
    const data: Prisma.FacilityUncheckedCreateInput = {
      tenantId: args.tenantId,
      name: args.input.name.trim(),
      address: args.input.address?.trim() || null,
      city: args.input.city?.trim() || null,
      postalCode: args.input.postalCode?.trim() || null,
      country: args.input.country,
      ...(args.input.latitude !== undefined ? { latitude: args.input.latitude } : {}),
      ...(args.input.longitude !== undefined ? { longitude: args.input.longitude } : {}),
      timezone: args.input.timezone,
      contactPhone: args.input.contactPhone?.trim() || null,
      contactEmail: args.input.contactEmail?.trim() || null,
    };
    const facility = await this.prisma.withTenant(
      (tx) => tx.facility.create({ data, include: { units: { select: { status: true } } } }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'facility.created',
      entityType: 'Facility',
      entityId: facility.id,
      changes: { name: facility.name },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(facility);
  }

  async update(args: UpdateArgs): Promise<FacilityDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.facility.findFirst({ where: { id: args.facilityId, deletedAt: null } }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }

    const data: Prisma.FacilityUpdateInput = {};
    const changes: Record<string, unknown> = {};
    const set = <K extends keyof UpdateFacilityInput>(key: K) => {
      const value = args.input[key];
      if (value === undefined) return;
      const cleaned =
        typeof value === 'string' && (value as string).length === 0 ? null : (value as never);
      (data as Record<string, unknown>)[key] = cleaned;
      changes[key] = cleaned;
    };
    set('name');
    set('address');
    set('city');
    set('postalCode');
    set('country');
    set('latitude');
    set('longitude');
    set('timezone');
    set('contactPhone');
    set('contactEmail');
    set('isActive');

    const facility = await this.prisma.withTenant(
      (tx) =>
        tx.facility.update({
          where: { id: args.facilityId },
          data,
          include: { units: { select: { status: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'facility.updated',
      entityType: 'Facility',
      entityId: facility.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(facility);
  }

  async softDelete(args: DeleteArgs): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({
          where: { id: args.facilityId, deletedAt: null },
          include: { units: { select: { id: true } } },
        }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.facility.update({
          where: { id: args.facilityId },
          data: { deletedAt: new Date(), isActive: false },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'facility.deleted',
      entityType: 'Facility',
      entityId: args.facilityId,
      changes: { unitsCount: existing.units.length },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  private toDto(f: FacilityWithStats): FacilityDto {
    const units = f.units ?? [];
    const occupied = units.filter((u) => u.status === 'occupied').length;
    return {
      id: f.id,
      name: f.name,
      address: f.address,
      city: f.city,
      postalCode: f.postalCode,
      country: f.country,
      latitude: f.latitude !== null && f.latitude !== undefined ? Number(f.latitude) : null,
      longitude: f.longitude !== null && f.longitude !== undefined ? Number(f.longitude) : null,
      timezone: f.timezone,
      openingHours: (f.openingHours as Record<string, unknown>) ?? {},
      contactPhone: f.contactPhone,
      contactEmail: f.contactEmail,
      isActive: f.isActive,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
      unitsTotal: units.length,
      unitsOccupied: occupied,
    };
  }
}
