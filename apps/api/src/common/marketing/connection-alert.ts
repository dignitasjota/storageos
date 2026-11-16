import { Logger } from '@nestjs/common';

import type { PrismaAdminService } from '../../modules/database/prisma-admin.service';
import type { NotificationsService } from '../../modules/notifications/notifications.service';
import type { Permission } from '@storageos/shared';

export type MarketingConnection = 'ga4' | 'social' | 'search_console';

const INFO: Record<MarketingConnection, { name: string; link: string; permission: Permission }> = {
  ga4: { name: 'Google Analytics', link: '/marketing/web', permission: 'marketing:read' },
  social: { name: 'Instagram y Facebook', link: '/marketing/social', permission: 'marketing:read' },
  search_console: { name: 'Google Search Console', link: '/seo', permission: 'settings:read' },
};

const logger = new Logger('ConnectionAlert');

/**
 * Tras la descarga diaria: si falló, avisa al equipo una vez (hasta que
 * vuelva a funcionar); si fue bien, deja listo el aviso para el próximo fallo.
 * La reserva del aviso es atómica: dos procesos no avisan dos veces.
 */
export async function noteConnectionResult(
  admin: PrismaAdminService,
  notifications: NotificationsService,
  tenantId: string,
  kind: MarketingConnection,
  ok: boolean,
  error?: string | null,
): Promise<void> {
  try {
    const where = ok
      ? { tenantId, errorNotifiedAt: { not: null } }
      : { tenantId, errorNotifiedAt: null };
    const data = { errorNotifiedAt: ok ? null : new Date() };
    const claimed =
      kind === 'ga4'
        ? await admin.tenantGa4.updateMany({ where, data })
        : kind === 'social'
          ? await admin.tenantSocialAccount.updateMany({ where, data })
          : await admin.tenantSearchConsole.updateMany({ where, data });
    if (ok || claimed.count === 0) return;
    const info = INFO[kind];
    await notifications.createForPermission(tenantId, info.permission, {
      type: 'marketing.connection_broken',
      title: `Se ha perdido la conexión con ${info.name}`,
      body: error
        ? `${error.slice(0, 200)} Mientras no se arregle, no se descargan datos nuevos.`
        : 'Mientras no se arregle, no se descargan datos nuevos.',
      link: info.link,
    });
  } catch (err) {
    logger.warn(`Aviso de conexión (${kind}) falló: ${(err as Error).message}`);
  }
}
