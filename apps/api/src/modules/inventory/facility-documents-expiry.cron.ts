import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Con cuántos días de antelación se avisa de que un documento del local caduca. */
export const FACILITY_DOCUMENT_NOTICE_DAYS = 30;

/**
 * Avisa (notificación in-app, una vez por documento y fecha) de los documentos
 * de un local que caducan en 30 días: licencias, seguros, contrato de la nave…
 * Corre en el worker (`ENABLE_WORKERS_IN_API=true`).
 */
@Injectable()
export class FacilityDocumentsExpiryCron {
  private readonly logger = new Logger(FacilityDocumentsExpiryCron.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron('30 7 * * *', { name: 'facility-documents.expiry' })
  async run(now = new Date()): Promise<{ notified: number }> {
    const limit = new Date(now.getTime() + FACILITY_DOCUMENT_NOTICE_DAYS * 86_400_000);
    const due = await this.admin.facilityDocument.findMany({
      where: {
        expiresOn: { not: null, lte: limit },
        expiryNotifiedAt: null,
        facility: { deletedAt: null },
      },
      select: {
        id: true,
        tenantId: true,
        facilityId: true,
        name: true,
        expiresOn: true,
        facility: { select: { name: true } },
      },
      take: 500,
    });
    let notified = 0;
    for (const d of due) {
      // Reserva atómica: con varias réplicas, solo una avisa.
      const claimed = await this.admin.facilityDocument.updateMany({
        where: { id: d.id, expiryNotifiedAt: null },
        data: { expiryNotifiedAt: now },
      });
      if (claimed.count === 0) continue;
      const expired = d.expiresOn! < now;
      const when = d.expiresOn!.toLocaleDateString('es-ES', { timeZone: 'UTC' });
      await this.notifications
        .create(d.tenantId, {
          type: 'facility.document_expiring',
          title: expired
            ? `Caducado: ${d.name} (${d.facility.name})`
            : `Caduca el ${when}: ${d.name} (${d.facility.name})`,
          body: 'Renueva el documento y sube la versión nueva en los ajustes del local.',
          link: `/facilities/${d.facilityId}?tab=documents`,
          facilityId: d.facilityId,
        })
        .catch(() => undefined);
      notified += 1;
    }
    if (notified > 0) this.logger.log(`[facility-documents] ${notified} aviso(s) de caducidad`);
    return { notified };
  }
}
