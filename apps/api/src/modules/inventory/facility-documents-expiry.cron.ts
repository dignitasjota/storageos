import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { todayInTimezone } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Con cuántos días de antelación se avisa de que un documento del local caduca. */
export const FACILITY_DOCUMENT_NOTICE_DAYS = 30;

/**
 * Avisa (notificación in-app) de los documentos de un local que caducan en 30
 * días —licencias, seguros, contrato de la nave…— y otra vez cuando ya han
 * caducado, por si el primer aviso se pasó. Una vez cada uno por documento y
 * fecha. Corre en el worker (`ENABLE_WORKERS_IN_API=true`).
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
    const today = todayInTimezone('Europe/Madrid', now);
    const due = await this.admin.facilityDocument.findMany({
      where: {
        facility: { deletedAt: null },
        OR: [
          { expiresOn: { not: null, lte: limit }, expiryNotifiedAt: null },
          { expiresOn: { not: null, lt: today }, expiredNotifiedAt: null },
        ],
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
      const expired = d.expiresOn! < today;
      // Reserva atómica: con varias réplicas, solo una avisa.
      const claimed = await this.admin.facilityDocument.updateMany({
        where: {
          id: d.id,
          ...(expired ? { expiredNotifiedAt: null } : { expiryNotifiedAt: null }),
        },
        data: { expiryNotifiedAt: now, ...(expired ? { expiredNotifiedAt: now } : {}) },
      });
      if (claimed.count === 0) continue;
      const when = d.expiresOn!.toLocaleDateString('es-ES', { timeZone: 'UTC' });
      await this.notifications
        .create(d.tenantId, {
          type: 'facility.document_expiring',
          title: expired
            ? `Caducado: ${d.name} (${d.facility.name})`
            : `Caduca el ${when}: ${d.name} (${d.facility.name})`,
          body: 'Renueva el documento y sube la versión nueva en la pestaña Documentos del local.',
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
