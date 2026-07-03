import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Facility, Prisma } from '@storageos/database';
import type { CreateFacilityInput, FacilityDto, UpdateFacilityInput } from '@storageos/shared';

type FacilityWithStats = Facility & {
  _count?: { units: number };
  units?: Array<{ status: string }>;
};

/** Slug URL-safe a partir de un texto (sin acentos, minúsculas, guiones). */
function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

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
    private readonly files: FilesService,
    private readonly limits: PlanLimitsService,
  ) {}

  async list(tenantId: string, facilityScope?: string[] | null): Promise<FacilityDto[]> {
    const facilities = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findMany({
          where: { deletedAt: null, ...(facilityScope ? { id: { in: facilityScope } } : {}) },
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

  /** Busca un publicSlug libre en el tenant a partir de un base (con sufijo -N). */
  private async freeSlug(
    tx: Prisma.TransactionClient,
    tenantId: string,
    base: string,
    excludeId?: string,
  ): Promise<string | null> {
    if (!base) return null;
    let candidate = base;
    let n = 1;
    // En la práctica converge en 1-2 iteraciones (slugs duplicados son raros).
    for (;;) {
      const clash = await tx.facility.findFirst({
        where: {
          tenantId,
          publicSlug: candidate,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
      });
      if (!clash) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
    }
  }

  async create(args: CreateArgs): Promise<FacilityDto> {
    // Enforcement del límite de locales del plan (+ add-ons de capacidad).
    const currentFacilities = await this.prisma.withTenant(
      (tx) => tx.facility.count({ where: { deletedAt: null } }),
      args.tenantId,
    );
    await this.limits.assertCanCreate(args.tenantId, 'facilities', currentFacilities);
    const facility = await this.prisma.withTenant(async (tx) => {
      const slug = await this.freeSlug(
        tx,
        args.tenantId,
        slugify(args.input.publicSlug?.trim() || args.input.name),
      );
      const data: Prisma.FacilityUncheckedCreateInput = {
        tenantId: args.tenantId,
        name: args.input.name.trim(),
        publicSlug: slug,
        address: args.input.address?.trim() || null,
        city: args.input.city?.trim() || null,
        postalCode: args.input.postalCode?.trim() || null,
        country: args.input.country,
        ...(args.input.latitude !== undefined ? { latitude: args.input.latitude } : {}),
        ...(args.input.longitude !== undefined ? { longitude: args.input.longitude } : {}),
        timezone: args.input.timezone,
        ...(args.input.accessCurfewEnabled !== undefined
          ? { accessCurfewEnabled: args.input.accessCurfewEnabled }
          : {}),
        ...(args.input.accessCurfewStart
          ? { accessCurfewStart: args.input.accessCurfewStart }
          : {}),
        ...(args.input.accessCurfewEnd ? { accessCurfewEnd: args.input.accessCurfewEnd } : {}),
        contactPhone: args.input.contactPhone?.trim() || null,
        contactEmail: args.input.contactEmail?.trim() || null,
      };
      return tx.facility.create({ data, include: { units: { select: { status: true } } } });
    }, args.tenantId);
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
    set('accessCurfewEnabled');
    set('accessCurfewStart');
    set('accessCurfewEnd');
    set('contactPhone');
    set('contactEmail');
    set('isActive');

    const facility = await this.prisma.withTenant(async (tx) => {
      // publicSlug solo se cambia si se envía explícitamente (no se regenera
      // al renombrar para no romper URLs SEO ya indexadas).
      if (args.input.publicSlug !== undefined) {
        const base = slugify(args.input.publicSlug);
        data.publicSlug = base
          ? await this.freeSlug(tx, args.tenantId, base, args.facilityId)
          : null;
        changes.publicSlug = data.publicSlug;
      }
      return tx.facility.update({
        where: { id: args.facilityId },
        data,
        include: { units: { select: { status: true } } },
      });
    }, args.tenantId);
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

  // -------------------------------------------------------------------
  // Imágenes (landing pública)
  // -------------------------------------------------------------------

  async requestImageUploadUrl(args: {
    tenantId: string;
    facilityId: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    await this.requireFacility(args.tenantId, args.facilityId);
    const key = this.files.buildFacilityImageKey(args.tenantId, args.facilityId, args.mimeType);
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: args.mimeType,
      contentLengthRange: { min: 1, max: args.sizeBytes },
    });
    return { uploadUrl, key, expiresIn };
  }

  /** Fija la lista completa de imágenes (añadir/quitar/reordenar) por sus keys. */
  async setImages(args: {
    tenantId: string;
    userId: string;
    facilityId: string;
    images: string[];
    meta: RequestMeta;
  }): Promise<FacilityDto> {
    await this.requireFacility(args.tenantId, args.facilityId);
    // Seguridad: cada key debe pertenecer a la carpeta de imágenes de ESTE local.
    const prefix = `${args.tenantId}/${args.facilityId}/images/`;
    const invalid = args.images.find((k) => !k.startsWith(prefix));
    if (invalid) {
      throw new NotFoundException({
        code: 'invalid_image_key',
        message: 'Una de las imágenes no pertenece a este local',
      });
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.facility.update({
          where: { id: args.facilityId },
          data: { images: args.images },
          include: { units: { select: { status: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'facility.images_updated',
      entityType: 'Facility',
      entityId: args.facilityId,
      changes: { count: args.images.length },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  private async requireFacility(tenantId: string, facilityId: string): Promise<void> {
    const facility = await this.prisma.withTenant(
      (tx) => tx.facility.findFirst({ where: { id: facilityId, deletedAt: null } }),
      tenantId,
    );
    if (!facility) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
  }

  private toDto(f: FacilityWithStats): FacilityDto {
    const units = f.units ?? [];
    const occupied = units.filter((u) => u.status === 'occupied').length;
    return {
      id: f.id,
      name: f.name,
      publicSlug: f.publicSlug,
      address: f.address,
      city: f.city,
      postalCode: f.postalCode,
      country: f.country,
      latitude: f.latitude !== null && f.latitude !== undefined ? Number(f.latitude) : null,
      longitude: f.longitude !== null && f.longitude !== undefined ? Number(f.longitude) : null,
      timezone: f.timezone,
      openingHours: (f.openingHours as Record<string, unknown>) ?? {},
      accessCurfewEnabled: f.accessCurfewEnabled,
      accessCurfewStart: f.accessCurfewStart,
      accessCurfewEnd: f.accessCurfewEnd,
      contactPhone: f.contactPhone,
      contactEmail: f.contactEmail,
      images: (f.images ?? []).map((key) => ({
        key,
        url: this.files.buildPublicUrl('public', key),
      })),
      isActive: f.isActive,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
      unitsTotal: units.length,
      unitsOccupied: occupied,
    };
  }
}
