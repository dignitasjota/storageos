import { Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminServiceStatusDto,
  ServiceIncidentDto,
  ServiceStatusDto,
  ServiceStatusValue,
  UpdateServiceStatusInput,
} from '@storageos/shared';

/** Incidencias que se enseñan en el historial del panel admin. */
const INCIDENT_HISTORY = 20;

const SEVERITY: Record<ServiceStatusValue, number> = { ok: 0, degraded: 1, incident: 2 };

/**
 * Estado del servicio que publica el super admin («todo bien», «funcionamiento
 * degradado» o «incidencia»). Un solo registro global y el historial de
 * incidencias: cada vez que se sale de «todo bien» empieza una y al volver se
 * cierra.
 */
@Injectable()
export class SupportServiceStatusService {
  constructor(private readonly admin: PrismaAdminService) {}

  private async current() {
    const row = await this.admin.platformServiceStatus.findFirst({
      orderBy: { updatedAt: 'desc' },
    });
    return row ?? (await this.admin.platformServiceStatus.create({ data: { status: 'ok' } }));
  }

  /** Lo que ve el negocio en Soporte. */
  async get(): Promise<ServiceStatusDto> {
    const row = await this.current();
    return {
      status: row.status as ServiceStatusValue,
      message: row.message,
      since: row.since.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getForAdmin(): Promise<AdminServiceStatusDto> {
    const [row, incidents] = await Promise.all([
      this.current(),
      this.admin.platformServiceIncident.findMany({
        orderBy: { startedAt: 'desc' },
        take: INCIDENT_HISTORY,
      }),
    ]);
    return {
      status: row.status as ServiceStatusValue,
      message: row.message,
      since: row.since.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      updatedByName: row.updatedByName,
      incidents: incidents.map(
        (i): ServiceIncidentDto => ({
          id: i.id,
          status: i.status as ServiceIncidentDto['status'],
          message: i.message,
          startedAt: i.startedAt.toISOString(),
          resolvedAt: i.resolvedAt?.toISOString() ?? null,
          createdByName: i.createdByName,
        }),
      ),
    };
  }

  async update(
    input: UpdateServiceStatusInput,
    superAdminId: string,
  ): Promise<AdminServiceStatusDto> {
    const [row, actor] = await Promise.all([
      this.current(),
      this.admin.superAdmin.findUnique({ where: { id: superAdminId }, select: { fullName: true } }),
    ]);
    const now = new Date();
    const next = input.status;
    const message = next === 'ok' ? null : input.message?.trim() || null;
    const prev = row.status as ServiceStatusValue;
    const actorName = actor?.fullName ?? null;
    await this.admin.$transaction(async (tx) => {
      const open = await tx.platformServiceIncident.findFirst({
        where: { resolvedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (next === 'ok') {
        if (open) {
          await tx.platformServiceIncident.update({
            where: { id: open.id },
            data: { resolvedAt: now },
          });
        }
      } else if (open) {
        // Sigue la misma incidencia: se queda con el peor estado y el último mensaje.
        const worst =
          SEVERITY[next] > SEVERITY[open.status as ServiceStatusValue] ? next : open.status;
        await tx.platformServiceIncident.update({
          where: { id: open.id },
          data: { status: worst, message },
        });
      } else {
        await tx.platformServiceIncident.create({
          data: { status: next, message, startedAt: now, createdByName: actorName },
        });
      }
      await tx.platformServiceStatus.update({
        where: { id: row.id },
        data: {
          status: next,
          message,
          // «Desde cuándo» solo cambia si cambia el estado.
          since: next === prev ? row.since : now,
          updatedByName: actorName,
        },
      });
    });
    return this.getForAdmin();
  }
}
