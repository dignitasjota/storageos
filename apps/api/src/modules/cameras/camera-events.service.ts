import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { RequestMeta } from '../auth/auth.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IncidentsService } from '../operations/incidents.service';

import { hashIngestToken } from './camera-devices.service';

import type { CameraEvent, CameraDevice, Prisma } from '@storageos/database';
import type {
  CameraEventDto,
  CameraEventKind,
  CreateIncidentFromEventInput,
  IncidentDto,
  IngestCameraEventInput,
} from '@storageos/shared';

interface EventFilters {
  facilityId?: string;
  kind?: CameraEventKind;
  incidentId?: string;
  facilityScope?: string[] | null;
}

type EventRow = CameraEvent & {
  device: Pick<CameraDevice, 'name' | 'facilityId'>;
  incident?: { title: string } | null;
};

const EVENT_INCLUDE = {
  device: { select: { name: true, facilityId: true } },
  incident: { select: { title: true } },
} satisfies Prisma.CameraEventInclude;

@Injectable()
export class CameraEventsService {
  private readonly logger = new Logger(CameraEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
    private readonly incidents: IncidentsService,
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
    if (filters.incidentId) where.incidentId = filters.incidentId;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.cameraEvent.findMany({
          where,
          include: EVENT_INCLUDE,
          orderBy: { occurredAt: 'desc' },
          take: Math.min(limit, 300),
        }),
      tenantId,
    );
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  /**
   * Crea una incidencia a partir de un evento (típicamente de alarma) y vincula
   * el evento a ella. Hereda el local del dispositivo; título y severidad por
   * defecto se derivan del evento (alarmas → high). Cierra el loop operativo:
   * alarma → incidencia → gestión.
   */
  async createIncidentFromEvent(args: {
    tenantId: string;
    userId: string;
    eventId: string;
    input: CreateIncidentFromEventInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<IncidentDto> {
    const event = await this.findEventOrThrow(args.tenantId, args.eventId, args.facilityScope);
    const isAlarm = event.kind === 'alarm';
    const incident = await this.incidents.create({
      tenantId: args.tenantId,
      userId: args.userId,
      input: {
        title: args.input.title ?? `${isAlarm ? 'Alarma' : 'Cámara'}: ${event.eventType}`,
        severity: args.input.severity ?? (isAlarm ? 'high' : 'medium'),
        facilityId: event.device.facilityId,
        occurredAt: event.occurredAt.toISOString(),
        metadata: { source: 'camera', cameraEventId: event.id, cameraDeviceId: event.cameraDeviceId },
      },
      meta: args.meta,
    });
    await this.prisma.withTenant(
      (tx) =>
        tx.cameraEvent.update({ where: { id: event.id }, data: { incidentId: incident.id } }),
      args.tenantId,
    );
    return incident;
  }

  /** Vincula un evento a una incidencia existente (ambos del mismo tenant). */
  async linkToIncident(args: {
    tenantId: string;
    eventId: string;
    incidentId: string;
    facilityScope?: string[] | null;
  }): Promise<CameraEventDto> {
    await this.findEventOrThrow(args.tenantId, args.eventId, args.facilityScope);
    const incident = await this.prisma.withTenant(
      (tx) => tx.incident.findFirst({ where: { id: args.incidentId, deletedAt: null } }),
      args.tenantId,
    );
    if (!incident) {
      throw new NotFoundException({ code: 'incident_not_found', message: 'Incidencia no encontrada' });
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.cameraEvent.update({
          where: { id: args.eventId },
          data: { incidentId: args.incidentId },
          include: EVENT_INCLUDE,
        }),
      args.tenantId,
    );
    return this.toDto(updated);
  }

  /** Desvincula un evento de su incidencia. */
  async unlinkFromIncident(
    tenantId: string,
    eventId: string,
    facilityScope?: string[] | null,
  ): Promise<CameraEventDto> {
    await this.findEventOrThrow(tenantId, eventId, facilityScope);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.cameraEvent.update({
          where: { id: eventId },
          data: { incidentId: null },
          include: EVENT_INCLUDE,
        }),
      tenantId,
    );
    return this.toDto(updated);
  }

  private async findEventOrThrow(
    tenantId: string,
    eventId: string,
    facilityScope?: string[] | null,
  ): Promise<EventRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.cameraEvent.findFirst({ where: { id: eventId }, include: EVENT_INCLUDE }),
      tenantId,
    );
    if (!row) throw new NotFoundException({ code: 'event_not_found', message: 'Evento no encontrado' });
    assertFacilityAllowed(facilityScope, row.device.facilityId);
    return row;
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
      incidentId: r.incidentId,
      incidentTitle: r.incident?.title ?? null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      occurredAt: r.occurredAt.toISOString(),
    };
  }
}
