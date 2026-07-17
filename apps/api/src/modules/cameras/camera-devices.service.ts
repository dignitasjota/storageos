import { createHash, randomBytes } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { CameraDevice, Facility, Prisma } from '@storageos/database';
import type {
  CameraDeviceDto,
  CameraDeviceWithTokenDto,
  CreateCameraDeviceInput,
  UpdateCameraDeviceInput,
} from '@storageos/shared';

type DeviceRow = CameraDevice & { facility?: Pick<Facility, 'name'> | null };

const INCLUDE = { facility: { select: { name: true } } } satisfies Prisma.CameraDeviceInclude;

/** sha256 hex del token de ingesta (lookup O(1); el token es de alta entropía). */
export function hashIngestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class CameraDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(
    tenantId: string,
    facilityScope?: string[] | null,
    facilityId?: string,
  ): Promise<CameraDeviceDto[]> {
    const facFilter = resolveFacilityFilter(facilityScope, facilityId);
    if (facFilter === null) return [];
    const where: Prisma.CameraDeviceWhereInput = {};
    if (facFilter) where.facilityId = { in: facFilter };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.cameraDevice.findMany({
          where,
          include: INCLUDE,
          orderBy: [{ facilityId: 'asc' }, { name: 'asc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateCameraDeviceInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<CameraDeviceWithTokenDto> {
    assertFacilityAllowed(args.facilityScope, args.input.facilityId);
    const token = randomBytes(24).toString('base64url');
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.cameraDevice.create({
          data: {
            tenantId: args.tenantId,
            facilityId: args.input.facilityId,
            name: args.input.name,
            channel: args.input.channel,
            provider: args.input.provider,
            serialNumber: args.input.serialNumber?.trim() || null,
            ingestTokenHash: hashIngestToken(token),
            ingestTokenPreview: token.slice(0, 8),
            metadata: args.input.metadata as Prisma.InputJsonValue,
          },
          include: INCLUDE,
        }),
      args.tenantId,
    );
    await this.writeAudit('camera.device_created', args, created.id);
    return { ...this.toDto(created), revealedIngestToken: token, ingestUrl: this.ingestUrl() };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateCameraDeviceInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<CameraDeviceDto> {
    await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    const data: Prisma.CameraDeviceUncheckedUpdateInput = {};
    const i = args.input;
    if (i.name !== undefined) data.name = i.name;
    if (i.channel !== undefined) data.channel = i.channel;
    if (i.provider !== undefined) data.provider = i.provider;
    if (i.serialNumber !== undefined) data.serialNumber = i.serialNumber?.trim() || null;
    if (i.facilityId !== undefined) {
      assertFacilityAllowed(args.facilityScope, i.facilityId);
      data.facilityId = i.facilityId;
    }
    if (i.isActive !== undefined) data.isActive = i.isActive;
    if (i.metadata !== undefined) data.metadata = i.metadata as Prisma.InputJsonValue;
    const updated = await this.prisma.withTenant(
      (tx) => tx.cameraDevice.update({ where: { id: args.id }, data, include: INCLUDE }),
      args.tenantId,
    );
    await this.writeAudit('camera.device_updated', args, args.id);
    return this.toDto(updated);
  }

  async regenerateToken(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<CameraDeviceWithTokenDto> {
    await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    const token = randomBytes(24).toString('base64url');
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.cameraDevice.update({
          where: { id: args.id },
          data: { ingestTokenHash: hashIngestToken(token), ingestTokenPreview: token.slice(0, 8) },
          include: INCLUDE,
        }),
      args.tenantId,
    );
    await this.writeAudit('camera.device_token_regenerated', args, args.id);
    return { ...this.toDto(updated), revealedIngestToken: token, ingestUrl: this.ingestUrl() };
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    await this.prisma.withTenant(
      (tx) => tx.cameraDevice.delete({ where: { id: args.id } }),
      args.tenantId,
    );
    await this.writeAudit('camera.device_deleted', args, args.id);
  }

  private async findOrThrow(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<DeviceRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.cameraDevice.findFirst({ where: { id }, include: INCLUDE }),
      tenantId,
    );
    if (!row) throw new NotFoundException({ code: 'camera_not_found', message: 'Cámara no encontrada' });
    assertFacilityAllowed(facilityScope, row.facilityId);
    return row;
  }

  private ingestUrl(): string {
    return `${this.config.get('API_BASE_URL', { infer: true })}/webhooks/cameras/events`;
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
      entityType: 'CameraDevice',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(d: DeviceRow): CameraDeviceDto {
    return {
      id: d.id,
      facilityId: d.facilityId,
      facilityName: d.facility?.name ?? '',
      name: d.name,
      channel: d.channel,
      provider: (d.provider as CameraDeviceDto['provider']) ?? 'dahua',
      serialNumber: d.serialNumber,
      ingestTokenPreview: d.ingestTokenPreview,
      isActive: d.isActive,
      lastEventAt: d.lastEventAt?.toISOString() ?? null,
      metadata: (d.metadata ?? {}) as Record<string, unknown>,
      createdAt: d.createdAt.toISOString(),
    };
  }
}
