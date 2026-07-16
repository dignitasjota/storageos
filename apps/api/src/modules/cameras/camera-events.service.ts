import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';

import { hashIngestToken } from './camera-devices.service';

import type { CameraEvent, CameraDevice, Prisma } from '@storageos/database';
import type { CameraEventDto, CameraEventKind, IngestCameraEventInput } from '@storageos/shared';

interface EventFilters {
  facilityId?: string;
  kind?: CameraEventKind;
  facilityScope?: string[] | null;
}

type EventRow = CameraEvent & { device: Pick<CameraDevice, 'name' | 'facilityId'> };

@Injectable()
export class CameraEventsService {
  private readonly logger = new Logger(CameraEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Ingesta de un evento empujado por el equipo/agente/puente. Autenticado por
   * el token de ingesta del dispositivo (cross-tenant: la fuente no conoce el
   * tenant). Guarda el snapshot en MinIO (bucket privado) e inserta el evento.
   */
  async ingest(token: string | undefined, input: IngestCameraEventInput): Promise<{ id: string }> {
    if (!token) throw new UnauthorizedException({ code: 'missing_token', message: 'Falta el token' });
    const device = await this.admin.cameraDevice.findUnique({
      where: { ingestTokenHash: hashIngestToken(token) },
      select: { id: true, tenantId: true, facilityId: true, name: true, isActive: true },
    });
    if (!device || !device.isActive) {
      throw new UnauthorizedException({ code: 'invalid_token', message: 'Token inválido' });
    }

    let snapshotKey: string | null = null;
    if (input.imageBase64) {
      try {
        const body = Buffer.from(input.imageBase64, 'base64');
        const mime = input.imageMimeType ?? 'image/jpeg';
        const key = this.files.buildCameraSnapshotKey(device.tenantId, device.id, mime);
        snapshotKey = await this.files.putObject({ bucket: 'uploads', key, body, contentType: mime });
      } catch (err) {
        // El snapshot es best-effort: el evento se registra igual sin imagen.
        this.logger.warn(
          `[cameras] snapshot del evento falló (device ${device.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const event = await this.admin.cameraEvent.create({
      data: {
        tenantId: device.tenantId,
        cameraDeviceId: device.id,
        kind: input.kind,
        eventType: input.eventType.slice(0, 80),
        snapshotKey,
        metadata: input.metadata as Prisma.InputJsonValue,
        occurredAt,
      },
      select: { id: true },
    });
    await this.admin.cameraDevice.update({
      where: { id: device.id },
      data: { lastEventAt: occurredAt },
    });

    // Aviso in-app al staff para eventos de ALARMA (intrusión): son accionables.
    if (input.kind === 'alarm') {
      try {
        await this.notifications.create(device.tenantId, {
          type: 'camera.alarm',
          title: `Alarma: ${input.eventType}`,
          body: `${device.name}`,
          link: `/cameras?facilityId=${device.facilityId}`,
        });
      } catch {
        /* best-effort */
      }
    }
    return { id: event.id };
  }

  /** Listado de eventos para el staff (con URL firmada del snapshot). */
  async list(
    tenantId: string,
    filters: EventFilters,
    limit = 100,
  ): Promise<CameraEventDto[]> {
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return [];
    const where: Prisma.CameraEventWhereInput = {};
    if (facFilter) where.device = { facilityId: { in: facFilter } };
    if (filters.kind) where.kind = filters.kind;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.cameraEvent.findMany({
          where,
          include: { device: { select: { name: true, facilityId: true } } },
          orderBy: { occurredAt: 'desc' },
          take: Math.min(limit, 300),
        }),
      tenantId,
    );
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  async snapshotUrl(
    tenantId: string,
    eventId: string,
    facilityScope?: string[] | null,
  ): Promise<{ url: string }> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.cameraEvent.findFirst({
          where: { id: eventId },
          include: { device: { select: { facilityId: true } } },
        }),
      tenantId,
    );
    if (!row?.snapshotKey) {
      throw new BadRequestException({ code: 'no_snapshot', message: 'El evento no tiene imagen' });
    }
    assertFacilityAllowed(facilityScope, row.device.facilityId);
    return { url: await this.files.getPresignedGetUrl('uploads', row.snapshotKey, 300) };
  }

  private async toDto(r: EventRow): Promise<CameraEventDto> {
    return {
      id: r.id,
      cameraDeviceId: r.cameraDeviceId,
      cameraName: r.device.name,
      facilityId: r.device.facilityId,
      kind: r.kind as CameraEventKind,
      eventType: r.eventType,
      snapshotUrl: r.snapshotKey
        ? await this.files.getPresignedGetUrl('uploads', r.snapshotKey, 300)
        : null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      occurredAt: r.occurredAt.toISOString(),
    };
  }
}
