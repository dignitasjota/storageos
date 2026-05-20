import { randomBytes } from 'node:crypto';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { LOCK_PROVIDER, type LockProvider } from './providers/lock-provider';

import type { RequestMeta } from '../auth/auth.service';
import type { AccessDevice, AccessDeviceType, Facility, Prisma, Unit } from '@storageos/database';
import type {
  AccessDeviceDto,
  AccessDeviceTypeValue,
  AccessDeviceWithKeyDto,
  CreateDeviceInput,
  UpdateDeviceInput,
} from '@storageos/shared';

interface ListFilters {
  facilityId?: string;
  type?: AccessDeviceTypeValue;
  isOnline?: boolean;
}

type DeviceWithIncludes = AccessDevice & {
  facility?: Pick<Facility, 'name'> | null;
  unit?: Pick<Unit, 'code'> | null;
};

const INCLUDE = {
  facility: { select: { name: true } },
  unit: { select: { code: true } },
} satisfies Prisma.AccessDeviceInclude;

function generateApiKey(): string {
  return randomBytes(32).toString('base64url');
}

@Injectable()
export class AccessDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(LOCK_PROVIDER) private readonly lock: LockProvider,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<AccessDeviceDto[]> {
    const where: Prisma.AccessDeviceWhereInput = {};
    if (filters.facilityId) where.facilityId = filters.facilityId;
    if (filters.type) where.type = filters.type as AccessDeviceType;
    if (filters.isOnline !== undefined) where.isOnline = filters.isOnline;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessDevice.findMany({
          where,
          include: INCLUDE,
          orderBy: [{ facilityId: 'asc' }, { name: 'asc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<AccessDeviceDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateDeviceInput;
    meta: RequestMeta;
  }): Promise<AccessDeviceWithKeyDto> {
    const apiKey = generateApiKey();
    const apiKeyHash = await argonHash(apiKey);
    const apiKeyPreview = apiKey.slice(0, 8);

    const data: Prisma.AccessDeviceUncheckedCreateInput = {
      tenantId: args.tenantId,
      facilityId: args.input.facilityId,
      unitId: args.input.unitId ?? null,
      type: args.input.type as AccessDeviceType,
      name: args.input.name,
      hardwareId: args.input.hardwareId,
      apiKeyHash,
      apiKeyPreview,
      mqttTopic: args.input.mqttTopic?.trim() || null,
      metadata: args.input.metadata as Prisma.InputJsonValue,
    };
    let created;
    try {
      created = await this.prisma.withTenant(
        (tx) => tx.accessDevice.create({ data, include: INCLUDE }),
        args.tenantId,
      );
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          code: 'device_hardware_id_taken',
          message: 'Ya existe un device con ese hardwareId',
        });
      }
      throw err;
    }
    await this.writeAudit('access.device_created', args, created.id);
    return { ...this.toDto(created), revealedApiKey: apiKey };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateDeviceInput;
    meta: RequestMeta;
  }): Promise<AccessDeviceDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const data: Prisma.AccessDeviceUncheckedUpdateInput = {};
    const input = args.input;
    if (input.name !== undefined) data.name = input.name;
    if (input.facilityId !== undefined) data.facilityId = input.facilityId;
    if (input.unitId !== undefined) data.unitId = input.unitId ?? null;
    if (input.type !== undefined) data.type = input.type as AccessDeviceType;
    if (input.hardwareId !== undefined) data.hardwareId = input.hardwareId;
    if (input.mqttTopic !== undefined) data.mqttTopic = input.mqttTopic?.trim() || null;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.metadata !== undefined) data.metadata = input.metadata as Prisma.InputJsonValue;

    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessDevice.update({
          where: { id: args.id },
          data,
          include: INCLUDE,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.device_updated', args, args.id);
    return this.toDto(updated);
  }

  async regenerateApiKey(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<AccessDeviceWithKeyDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const apiKey = generateApiKey();
    const apiKeyHash = await argonHash(apiKey);
    const apiKeyPreview = apiKey.slice(0, 8);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessDevice.update({
          where: { id: args.id },
          data: { apiKeyHash, apiKeyPreview },
          include: INCLUDE,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.device_api_key_regenerated', args, args.id);
    return { ...this.toDto(updated), revealedApiKey: apiKey };
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id);
    await this.prisma.withTenant(
      (tx) => tx.accessDevice.delete({ where: { id: args.id } }),
      args.tenantId,
    );
    await this.writeAudit('access.device_deleted', args, args.id);
  }

  async ping(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<{ online: boolean }> {
    const device = await this.findOrThrow(args.tenantId, args.id);
    const result = await this.lock.open({
      tenantId: args.tenantId,
      deviceId: device.id,
      mqttTopic: device.mqttTopic,
      // sin customerId: es un ping, no una apertura real para un customer.
    });
    if (result.dispatched) {
      await this.prisma.withTenant(
        (tx) =>
          tx.accessDevice.update({
            where: { id: device.id },
            data: { isOnline: true, lastSeenAt: new Date() },
          }),
        args.tenantId,
      );
    }
    await this.writeAudit('access.device_pinged', args, device.id);
    return { online: result.dispatched };
  }

  private async findOrThrow(tenantId: string, id: string): Promise<DeviceWithIncludes> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.accessDevice.findFirst({
          where: { id },
          include: INCLUDE,
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'device_not_found',
        message: 'Dispositivo no encontrado',
      });
    }
    return row as DeviceWithIncludes;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'AccessDevice',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(d: DeviceWithIncludes): AccessDeviceDto {
    return {
      id: d.id,
      facilityId: d.facilityId,
      facilityName: d.facility?.name ?? '',
      unitId: d.unitId,
      unitCode: d.unit?.code ?? null,
      type: d.type as AccessDeviceTypeValue,
      name: d.name,
      hardwareId: d.hardwareId,
      apiKeyPreview: d.apiKeyPreview,
      mqttTopic: d.mqttTopic,
      isOnline: d.isOnline,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      isActive: d.isActive,
      metadata: (d.metadata ?? {}) as Record<string, unknown>,
      createdAt: d.createdAt.toISOString(),
    };
  }
}
