import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_TENANT_DATA_EXPORT, QUEUE_REPORTS } from '../queues/queue-names';

import { TenantDataExportService } from './tenant-data-export.service';

import type { AdminTenantDataExportDto } from '@storageos/shared';

/** El fichero se borra a los 2 días (limpieza de `exports/`). */
const FILE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export interface TenantDataExportJobData {
  exportId: string;
}

/**
 * Exportaciones de los datos de un tenant hechas por el super admin: se piden,
 * se generan en segundo plano (cola de informes), avisan al terminar con una
 * notificación a quien la pidió y quedan en su historial.
 */
@Injectable()
export class TenantDataExportJobsService {
  private readonly logger = new Logger(TenantDataExportJobsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly exporter: TenantDataExportService,
    @InjectQueue(QUEUE_REPORTS) private readonly queue: Queue,
  ) {}

  async request(tenantId: string, superAdminId: string): Promise<AdminTenantDataExportDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const row = await this.admin.tenantDataExport.create({
      data: { tenantId, superAdminId },
      include: { superAdmin: { select: { fullName: true } } },
    });
    await this.queue.add(
      JOB_TENANT_DATA_EXPORT,
      { exportId: row.id } satisfies TenantDataExportJobData,
      { attempts: 2, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 100 },
    );
    return this.toDto(row);
  }

  /** La genera (lo llama el procesador de la cola). */
  async process(exportId: string): Promise<void> {
    const row = await this.admin.tenantDataExport.findUnique({
      where: { id: exportId },
      include: { tenant: { select: { name: true } } },
    });
    if (!row || row.status === 'done') return;
    try {
      const built = await this.exporter.buildFile(row.tenantId);
      await this.admin.tenantDataExport.update({
        where: { id: exportId },
        data: {
          status: 'done',
          fileKey: built.key,
          fileBytes: built.fileBytes,
          counts: built.counts,
          error: null,
          finishedAt: new Date(),
        },
      });
      await this.notify(row.superAdminId, row.tenantId, `Exportación lista: ${row.tenant.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Exportación ${exportId} fallida: ${message}`);
      await this.admin.tenantDataExport.update({
        where: { id: exportId },
        data: { status: 'failed', error: message.slice(0, 500), finishedAt: new Date() },
      });
      await this.notify(
        row.superAdminId,
        row.tenantId,
        `No se pudo exportar ${row.tenant.name}`,
        message.slice(0, 200),
      );
    }
  }

  private async notify(
    recipientId: string | null,
    tenantId: string,
    title: string,
    body?: string,
  ): Promise<void> {
    await this.admin.superAdminNotification
      .create({
        data: {
          type: 'tenant.data_export',
          title,
          body: body ?? 'Descárgala desde la ficha del tenant (Más → Exportaciones).',
          link: `/admin/tenants/${tenantId}?tab=exports`,
          recipientId,
        },
      })
      .catch(() => undefined);
  }

  async list(tenantId: string): Promise<AdminTenantDataExportDto[]> {
    const rows = await this.admin.tenantDataExport.findMany({
      where: { tenantId },
      include: { superAdmin: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return rows.map((r) => this.toDto(r));
  }

  async downloadUrl(tenantId: string, exportId: string): Promise<{ url: string }> {
    const row = await this.admin.tenantDataExport.findFirst({ where: { id: exportId, tenantId } });
    if (!row?.fileKey || row.status !== 'done') {
      throw new NotFoundException({
        code: 'export_not_ready',
        message: 'Exportación no disponible',
      });
    }
    if (Date.now() - (row.finishedAt ?? row.createdAt).getTime() > FILE_TTL_MS) {
      throw new NotFoundException({
        code: 'export_expired',
        message: 'El fichero ya se ha borrado (dura 2 días): vuelve a exportar.',
      });
    }
    return { url: await this.exporter.downloadUrl(row.fileKey) };
  }

  private toDto(r: {
    id: string;
    status: string;
    createdAt: Date;
    finishedAt: Date | null;
    fileBytes: number | null;
    counts: unknown;
    error: string | null;
    superAdmin: { fullName: string } | null;
  }): AdminTenantDataExportDto {
    return {
      id: r.id,
      status: r.status as AdminTenantDataExportDto['status'],
      requestedByName: r.superAdmin?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      fileBytes: r.fileBytes,
      counts: (r.counts as Record<string, number> | null) ?? null,
      error: r.error,
      expired:
        r.status === 'done' && Date.now() - (r.finishedAt ?? r.createdAt).getTime() > FILE_TTL_MS,
    };
  }
}
